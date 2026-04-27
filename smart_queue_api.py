"""Smart Queue Management System — Backend v2.1
Features: SQLite, WebSockets, Multi-Queue, Dynamic Timing, No-Show, Analytics, JWT Auth"""

from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_socketio import SocketIO, join_room, leave_room
from flask_sqlalchemy import SQLAlchemy
from apscheduler.schedulers.background import BackgroundScheduler
from datetime import datetime, timedelta
from functools import wraps
import uuid, math, hashlib, jwt as pyjwt

app = Flask(__name__)
app.config['SECRET_KEY'] = 'smartqueue-2025'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///queue.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

CORS(app, resources={r"/*": {"origins": "*"}})
db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

ROLLING_WINDOW = 10
SUGGEST_THRESHOLD = 15
DEFAULT_GRACE = 3.0
JWT_SECRET = 'smartqueue-jwt-secret-2025'
JWT_EXPIRY_HOURS = 24

# ── AUTH HELPERS ─────────────────────────────────────────────────────

def hash_pw(pw): return hashlib.sha256(pw.encode()).hexdigest()

def make_token(user_id, role):
    payload = {'sub': str(user_id), 'role': role,
                'exp': datetime.utcnow() + timedelta(hours=JWT_EXPIRY_HOURS)}
    return pyjwt.encode(payload, JWT_SECRET, algorithm='HS256')

def decode_token(token):
    data = pyjwt.decode(token, JWT_SECRET, algorithms=['HS256'])
    data['sub'] = int(data['sub'])  # convert back to int
    return data

def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get('Authorization', '')
        if not auth.startswith('Bearer '):
            return jsonify({'error': 'Token missing'}), 401
        try:
            data = decode_token(auth.split(' ')[1])
        except pyjwt.ExpiredSignatureError:
            return jsonify({'error': 'Token expired'}), 401
        except Exception:
            return jsonify({'error': 'Invalid token'}), 401
        request.user_id = data['sub']
        request.user_role = data['role']
        return f(*args, **kwargs)
    return decorated

def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get('Authorization', '')
        if not auth.startswith('Bearer '):
            return jsonify({'error': 'Token missing'}), 401
        try:
            data = decode_token(auth.split(' ')[1])
        except Exception:
            return jsonify({'error': 'Invalid token'}), 401
        if data.get('role') != 'admin':
            return jsonify({'error': 'Admin access required'}), 403
        request.user_id = data['sub']
        request.user_role = 'admin'
        return f(*args, **kwargs)
    return decorated

# ── MODELS ──────────────────────────────────────────────────────────

class ServiceQueue(db.Model):
    __tablename__ = 'service_queues'
    id               = db.Column(db.Integer, primary_key=True)
    name             = db.Column(db.String(100), nullable=False)
    description      = db.Column(db.String(200), default='')
    avg_service_time = db.Column(db.Float, default=5.0)
    grace_minutes    = db.Column(db.Float, default=DEFAULT_GRACE)
    is_active        = db.Column(db.Boolean, default=True)
    geo_required     = db.Column(db.Boolean, default=False)
    geo_lat          = db.Column(db.Float, nullable=True)
    geo_lng          = db.Column(db.Float, nullable=True)
    geo_radius_m     = db.Column(db.Float, default=500.0)
    created_at       = db.Column(db.DateTime, default=datetime.utcnow)

class QueueEntry(db.Model):
    __tablename__ = 'queue_entries'
    id           = db.Column(db.Integer, primary_key=True)
    queue_id     = db.Column(db.Integer, db.ForeignKey('service_queues.id'), nullable=False)
    name         = db.Column(db.String(100), nullable=False)
    token        = db.Column(db.String(36), unique=True, default=lambda: str(uuid.uuid4()))
    position     = db.Column(db.Integer, nullable=False)
    priority     = db.Column(db.Boolean, default=False)
    status       = db.Column(db.String(20), default='waiting')
    joined_at    = db.Column(db.DateTime, default=datetime.utcnow)
    turn_at      = db.Column(db.DateTime, nullable=True)
    window_start = db.Column(db.DateTime, nullable=True)
    window_end   = db.Column(db.DateTime, nullable=True)
    checkin_at   = db.Column(db.DateTime, nullable=True)
    served_at    = db.Column(db.DateTime, nullable=True)

class UserProfile(db.Model):
    __tablename__ = 'user_profiles'
    name              = db.Column(db.String(100), primary_key=True)
    total_joins       = db.Column(db.Integer, default=0)
    no_shows          = db.Column(db.Integer, default=0)
    on_time           = db.Column(db.Integer, default=0)
    late_checkins     = db.Column(db.Integer, default=0)
    reliability_score = db.Column(db.Float, default=100.0)
    last_seen         = db.Column(db.DateTime, default=datetime.utcnow)

class ServiceLog(db.Model):
    __tablename__ = 'service_log'
    id           = db.Column(db.Integer, primary_key=True)
    queue_id     = db.Column(db.Integer, db.ForeignKey('service_queues.id'))
    user_name    = db.Column(db.String(100))
    duration_min = db.Column(db.Float)
    served_at    = db.Column(db.DateTime, default=datetime.utcnow)

class AnalyticsHourly(db.Model):
    __tablename__ = 'analytics_hourly'
    id        = db.Column(db.Integer, primary_key=True)
    queue_id  = db.Column(db.Integer, db.ForeignKey('service_queues.id'))
    hour      = db.Column(db.String(20))   # "YYYY-MM-DD HH"
    joins     = db.Column(db.Integer, default=0)
    served    = db.Column(db.Integer, default=0)
    no_shows  = db.Column(db.Integer, default=0)
    avg_wait  = db.Column(db.Float, default=0.0)

class User(db.Model):
    __tablename__ = 'users'
    id            = db.Column(db.Integer, primary_key=True)
    username      = db.Column(db.String(80), unique=True, nullable=False)
    email         = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(64), nullable=False)
    role          = db.Column(db.String(10), default='user')  # 'user' | 'admin'
    created_at    = db.Column(db.DateTime, default=datetime.utcnow)

# ── HELPERS ─────────────────────────────────────────────────────────

def get_rolling_avg(queue_id):
    logs = ServiceLog.query.filter_by(queue_id=queue_id)\
               .order_by(ServiceLog.served_at.desc()).limit(ROLLING_WINDOW).all()
    if len(logs) >= 3:
        return round(sum(l.duration_min for l in logs) / len(logs), 2)
    q = ServiceQueue.query.get(queue_id)
    return q.avg_service_time if q else 5.0

def active_entries(queue_id):
    return QueueEntry.query.filter_by(queue_id=queue_id)\
        .filter(QueueEntry.status.in_(['waiting','checkin_pending','checked_in']))\
        .order_by(QueueEntry.position)

def recalculate_queue(queue_id):
    q = ServiceQueue.query.get(queue_id)
    if not q: return
    avg = get_rolling_avg(queue_id)
    entries = active_entries(queue_id).all()
    now = datetime.utcnow()
    for idx, e in enumerate(entries):
        e.position = idx + 1
        wait = (e.position - 1) * avg
        e.turn_at      = now + timedelta(minutes=wait)
        e.window_start = e.turn_at - timedelta(minutes=2)
        e.window_end   = e.turn_at + timedelta(minutes=q.grace_minutes)
        if e.position == 1 and e.status == 'waiting':
            e.status = 'checkin_pending'
    db.session.commit()

def update_reliability(name, event):
    p = UserProfile.query.get(name)
    if not p:
        p = UserProfile(name=name, total_joins=0, no_shows=0,
                        on_time=0, late_checkins=0, reliability_score=100.0)
        db.session.add(p)
        db.session.flush()   # assign defaults before we increment
    if event == 'join':     p.total_joins    = (p.total_joins    or 0) + 1
    elif event == 'missed': p.no_shows       = (p.no_shows       or 0) + 1
    elif event == 'on_time': p.on_time       = (p.on_time        or 0) + 1
    elif event == 'late':   p.late_checkins  = (p.late_checkins  or 0) + 1
    ns = p.no_shows or 0; ot = p.on_time or 0; lc = p.late_checkins or 0
    p.reliability_score = max(0.0, min(100.0, 100.0 - ns*20 + ot*5 - lc*2))
    p.last_seen = datetime.utcnow()
    db.session.commit()
    return p.reliability_score

def log_analytics(queue_id, event, wait=0):
    hour = datetime.utcnow().strftime('%Y-%m-%d %H')
    row = AnalyticsHourly.query.filter_by(queue_id=queue_id, hour=hour).first()
    if not row:
        row = AnalyticsHourly(queue_id=queue_id, hour=hour,
                               joins=0, served=0, no_shows=0, avg_wait=0.0)
        db.session.add(row)
        db.session.flush()
    if event == 'join':     row.joins    = (row.joins    or 0) + 1
    elif event == 'served': row.served   = (row.served   or 0) + 1
    elif event == 'missed': row.no_shows = (row.no_shows or 0) + 1
    if wait:
        old = row.avg_wait or 0.0
        row.avg_wait = (old + wait) / 2
    db.session.commit()

def haversine(lat1, lng1, lat2, lng2):
    R = 6371000
    p = math.pi/180
    a = math.sin((lat2-lat1)*p/2)**2 + math.cos(lat1*p)*math.cos(lat2*p)*math.sin((lng2-lng1)*p/2)**2
    return 2*R*math.asin(math.sqrt(a))

def build_entry_dict(e, avg):
    now = datetime.utcnow()
    p = UserProfile.query.get(e.name)
    secs = max(0, int((e.turn_at - now).total_seconds())) if e.turn_at else 0
    return {
        'id': e.id, 'name': e.name, 'position': e.position,
        'priority': e.priority, 'status': e.status, 'token': e.token,
        'waiting_time': round((e.position-1)*avg, 1),
        'seconds_remaining': secs,
        'window_start': e.window_start.strftime('%H:%M') if e.window_start else None,
        'window_end':   e.window_end.strftime('%H:%M')   if e.window_end   else None,
        'reliability_score': round(p.reliability_score, 1) if p else 100.0,
    }

def emit_queue_update(queue_id):
    with app.app_context():
        q = ServiceQueue.query.get(queue_id)
        if not q: return
        avg = get_rolling_avg(queue_id)
        entries = active_entries(queue_id).all()
        payload = {
            'queue_id': queue_id, 'queue_name': q.name,
            'queue': [build_entry_dict(e, avg) for e in entries],
            'total_people': len(entries), 'avg_time': avg,
        }
        socketio.emit('queue_update', payload, room=f'q{queue_id}')
        served_total = QueueEntry.query.filter_by(queue_id=queue_id, status='served').count()
        missed_total = QueueEntry.query.filter_by(queue_id=queue_id, status='missed').count()
        socketio.emit('stats_update', {
            'queue_id': queue_id, 'total_in_queue': len(entries),
            'served': served_total, 'missed': missed_total, 'avg_time': avg,
        }, room=f'q{queue_id}')
        if len(entries) >= SUGGEST_THRESHOLD:
            socketio.emit('suggest_counter', {
                'queue_id': queue_id, 'queue_name': q.name, 'count': len(entries)
            }, room='admin_room')

# ── NO-SHOW JOB ──────────────────────────────────────────────────────

def check_no_shows():
    with app.app_context():
        now = datetime.utcnow()
        expired = QueueEntry.query.filter_by(status='checkin_pending')\
                      .filter(QueueEntry.window_end < now).all()
        affected = set()
        for e in expired:
            e.status = 'missed'
            update_reliability(e.name, 'missed')
            log_analytics(e.queue_id, 'missed')
            socketio.emit('user_alert', {
                'name': e.name, 'type': 'missed', 'queue_id': e.queue_id,
                'message': 'You missed your turn. Please rejoin.',
            }, room=f'user_{e.name.lower()}')
            socketio.emit('user_alert', {
                'name': e.name, 'type': 'missed', 'queue_id': e.queue_id,
                'message': f'{e.name} missed their turn (no check-in)',
            }, room='admin_room')
            affected.add(e.queue_id)
        db.session.commit()
        for qid in affected:
            recalculate_queue(qid)
            emit_queue_update(qid)

# ── SOCKET EVENTS ────────────────────────────────────────────────────

@socketio.on('subscribe_queue')
def on_sub_queue(data):
    join_room(f'q{data.get("queue_id",1)}')

@socketio.on('subscribe_admin')
def on_sub_admin(data):
    join_room('admin_room')

@socketio.on('subscribe_user')
def on_sub_user(data):
    name = data.get('name','').lower()
    if name: join_room(f'user_{name}')

@socketio.on('unsubscribe_queue')
def on_unsub(data):
    leave_room(f'q{data.get("queue_id",1)}')

# ── QUEUE CRUD ───────────────────────────────────────────────────────

@app.route('/queues', methods=['GET'])
def list_queues():
    rows = ServiceQueue.query.filter_by(is_active=True).all()
    return jsonify([{
        'id': q.id, 'name': q.name, 'description': q.description,
        'avg_time': q.avg_service_time, 'grace_minutes': q.grace_minutes,
        'geo_required': q.geo_required,
        'active_count': active_entries(q.id).count(),
    } for q in rows]), 200

@app.route('/queues', methods=['POST'])
def create_queue():
    d = request.get_json() or {}
    if not d.get('name'):
        return jsonify({'error': 'name required'}), 400
    q = ServiceQueue(name=d['name'].strip(), description=d.get('description',''),
                     avg_service_time=float(d.get('avg_time',5)),
                     grace_minutes=float(d.get('grace_minutes', DEFAULT_GRACE)),
                     geo_required=bool(d.get('geo_required',False)),
                     geo_lat=d.get('geo_lat'), geo_lng=d.get('geo_lng'),
                     geo_radius_m=float(d.get('geo_radius_m',500)))
    db.session.add(q); db.session.commit()
    return jsonify({'id': q.id, 'name': q.name}), 201

@app.route('/queues/<int:qid>', methods=['DELETE'])
def delete_queue(qid):
    q = ServiceQueue.query.get_or_404(qid)
    q.is_active = False; db.session.commit()
    return jsonify({'message': f'"{q.name}" deactivated'}), 200

# ── JOIN ─────────────────────────────────────────────────────────────

def _join(qid, data):
    q = ServiceQueue.query.get(qid)
    if not q or not q.is_active:
        return jsonify({'error': 'Queue not found or inactive'}), 404
    name = (data.get('name') or '').strip()
    if not name: return jsonify({'error': 'Name is required'}), 400
    if active_entries(qid).filter_by(name=name).first():
        return jsonify({'error': f'"{name}" is already in this queue'}), 409
    priority = bool(data.get('priority', False))
    avg = get_rolling_avg(qid)
    if priority:
        last_p = active_entries(qid).filter_by(priority=True)\
                     .order_by(QueueEntry.position.desc()).first()
        pos = (last_p.position + 1) if last_p else 1
        for e in active_entries(qid).filter(QueueEntry.position >= pos).all():
            e.position += 1
    else:
        pos = active_entries(qid).count() + 1
    now = datetime.utcnow()
    wait = (pos-1)*avg
    turn = now + timedelta(minutes=wait)
    e = QueueEntry(queue_id=qid, name=name, position=pos, priority=priority,
                   status='checkin_pending' if pos==1 else 'waiting',
                   turn_at=turn,
                   window_start=turn - timedelta(minutes=2),
                   window_end=turn + timedelta(minutes=q.grace_minutes))
    db.session.add(e); db.session.commit()
    update_reliability(name, 'join')
    log_analytics(qid, 'join', wait)
    recalculate_queue(qid)
    emit_queue_update(qid)
    p = UserProfile.query.get(name)
    return jsonify({
        'name': name, 'token': e.token, 'position': e.position,
        'waiting_time': round(wait,1), 'queue_id': qid, 'queue_name': q.name,
        'estimated_turn_time': turn.strftime('%H:%M:%S'),
        'window_start': e.window_start.strftime('%H:%M'),
        'window_end':   e.window_end.strftime('%H:%M'),
        'status': e.status,
        'reliability_score': round(p.reliability_score,1) if p else 100.0,
    }), 200

@app.route('/queues/<int:qid>/join', methods=['POST'])
def join_queue(qid):
    return _join(qid, request.get_json() or {})

@app.route('/join', methods=['POST'])
def join_default():
    return _join(1, request.get_json() or {})

# ── GET QUEUE ─────────────────────────────────────────────────────────

def _get_queue(qid):
    q = ServiceQueue.query.get(qid)
    if not q: return jsonify({'error': 'Queue not found'}), 404
    avg = get_rolling_avg(qid)
    entries = active_entries(qid).all()
    return jsonify({
        'queue': [build_entry_dict(e, avg) for e in entries],
        'total_people': len(entries), 'avg_time': avg,
        'queue_id': qid, 'queue_name': q.name,
    }), 200

@app.route('/queues/<int:qid>/queue', methods=['GET'])
def get_queue(qid): return _get_queue(qid)

@app.route('/queue', methods=['GET'])
def get_default_queue(): return _get_queue(1)

# ── CHECK-IN ──────────────────────────────────────────────────────────

@app.route('/queues/<int:qid>/checkin', methods=['POST'])
def checkin(qid):
    d = request.get_json() or {}
    token = d.get('token')
    if not token: return jsonify({'error': 'Token required'}), 400
    e = QueueEntry.query.filter_by(queue_id=qid, token=token).first()
    if not e: return jsonify({'error': 'Invalid token'}), 404
    if e.status not in ('waiting','checkin_pending'):
        return jsonify({'error': f'Cannot check in — status is "{e.status}"'}), 409
    q = ServiceQueue.query.get(qid)
    if q.geo_required:
        lat, lng = d.get('lat'), d.get('lng')
        if lat is None or lng is None:
            return jsonify({'error': 'Location required'}), 400
        dist = haversine(lat, lng, q.geo_lat, q.geo_lng)
        if dist > q.geo_radius_m:
            return jsonify({'error': f'Too far: {int(dist)}m (max {int(q.geo_radius_m)}m)'}), 403
    now = datetime.utcnow()
    e.checkin_at = now; e.status = 'checked_in'
    update_reliability(e.name, 'on_time' if (e.turn_at and now <= e.window_end) else 'late')
    db.session.commit(); emit_queue_update(qid)
    return jsonify({'message': 'Check-in successful', 'name': e.name, 'position': e.position}), 200

# ── SERVE (Admin) ─────────────────────────────────────────────────────

@app.route('/queues/<int:qid>/serve', methods=['POST'])
def serve_next(qid):
    e = active_entries(qid).first()
    if not e: return jsonify({'error': 'Queue is empty'}), 404
    now = datetime.utcnow()
    dur = (now - e.checkin_at).total_seconds()/60 if e.checkin_at else get_rolling_avg(qid)
    e.status = 'served'; e.served_at = now
    db.session.add(ServiceLog(queue_id=qid, user_name=e.name, duration_min=max(0.5,dur)))
    db.session.commit()
    log_analytics(qid, 'served')
    recalculate_queue(qid); emit_queue_update(qid)
    nxt = active_entries(qid).first()
    if nxt:
        socketio.emit('user_alert', {
            'name': nxt.name, 'type': 'near',
            'message': "🔔 You're next! Please get ready.",
        }, room=f'user_{nxt.name.lower()}')
    return jsonify({'message': f'"{e.name}" served', 'duration_min': round(dur,2)}), 200

# ── REMOVE ────────────────────────────────────────────────────────────

def _remove(qid, name):
    e = active_entries(qid).filter_by(name=name).first()
    if not e: return jsonify({'error': f'"{name}" not found'}), 404
    e.status = 'served'; e.served_at = datetime.utcnow()
    db.session.commit(); recalculate_queue(qid); emit_queue_update(qid)
    return jsonify({'message': f'"{name}" removed'}), 200

@app.route('/queues/<int:qid>/remove', methods=['POST'])
def remove_from_queue(qid):
    d = request.get_json() or {}
    return _remove(qid, (d.get('name') or '').strip())

@app.route('/remove', methods=['POST'])
def remove_default():
    d = request.get_json() or {}
    return _remove(1, (d.get('name') or '').strip())

# ── UPDATE TIME ───────────────────────────────────────────────────────

def _update_time(qid, avg_time):
    try:
        t = float(avg_time)
        assert t > 0
    except Exception:
        return jsonify({'error': 'avg_time must be positive number'}), 400
    q = ServiceQueue.query.get_or_404(qid)
    q.avg_service_time = t; db.session.commit()
    recalculate_queue(qid); emit_queue_update(qid)
    return jsonify({'message': f'Updated to {t} min'}), 200

@app.route('/queues/<int:qid>/update-time', methods=['POST'])
def update_time(qid):
    return _update_time(qid, (request.get_json() or {}).get('avg_time'))

@app.route('/update-time', methods=['POST'])
def update_time_default():
    return _update_time(1, (request.get_json() or {}).get('avg_time'))

# ── CLEAR ─────────────────────────────────────────────────────────────

def _clear(qid):
    entries = active_entries(qid).all()
    now = datetime.utcnow()
    for e in entries: e.status = 'served'; e.served_at = now
    db.session.commit(); emit_queue_update(qid)
    return jsonify({'message': f'{len(entries)} users cleared'}), 200

@app.route('/queues/<int:qid>/clear', methods=['POST'])
def clear_queue(qid): return _clear(qid)

@app.route('/clear', methods=['POST'])
def clear_default(): return _clear(1)

# ── STATS ─────────────────────────────────────────────────────────────

@app.route('/stats', methods=['GET'])
def global_stats():
    queues = ServiceQueue.query.filter_by(is_active=True).all()
    result = []
    for q in queues:
        result.append({
            'queue_id': q.id, 'queue_name': q.name,
            'total_in_queue': active_entries(q.id).count(),
            'served': QueueEntry.query.filter_by(queue_id=q.id, status='served').count(),
            'missed': QueueEntry.query.filter_by(queue_id=q.id, status='missed').count(),
            'avg_time': get_rolling_avg(q.id),
        })
    return jsonify(result), 200

@app.route('/queues/<int:qid>/stats', methods=['GET'])
def queue_stats(qid):
    q = ServiceQueue.query.get_or_404(qid)
    total = active_entries(qid).count()
    served = QueueEntry.query.filter_by(queue_id=qid, status='served').count()
    missed = QueueEntry.query.filter_by(queue_id=qid, status='missed').count()
    no_show_rate = round(missed/(served+missed)*100, 1) if (served+missed) else 0
    return jsonify({
        'queue_id': qid, 'queue_name': q.name,
        'total_in_queue': total, 'served': served, 'missed': missed,
        'no_show_rate': no_show_rate, 'avg_time': get_rolling_avg(qid),
    }), 200

# ── ANALYTICS ─────────────────────────────────────────────────────────

@app.route('/queues/<int:qid>/analytics', methods=['GET'])
def analytics(qid):
    rows = AnalyticsHourly.query.filter_by(queue_id=qid)\
               .order_by(AnalyticsHourly.hour.desc()).limit(24).all()
    rows.reverse()
    no_show_rate = 0
    total_s = QueueEntry.query.filter_by(queue_id=qid, status='served').count()
    total_m = QueueEntry.query.filter_by(queue_id=qid, status='missed').count()
    if total_s + total_m: no_show_rate = round(total_m/(total_s+total_m)*100, 1)
    peak = max(rows, key=lambda r: r.joins, default=None)
    return jsonify({
        'queue_id': qid,
        'hourly': [{'hour': r.hour, 'joins': r.joins, 'served': r.served,
                    'no_shows': r.no_shows, 'avg_wait': r.avg_wait} for r in rows],
        'peak_hour': peak.hour if peak else None,
        'no_show_rate': no_show_rate,
        'total_served': total_s, 'total_missed': total_m,
    }), 200

# ── USER SCORE ────────────────────────────────────────────────────────

@app.route('/users/<name>/score', methods=['GET'])
def user_score(name):
    p = UserProfile.query.get(name)
    if not p: return jsonify({'error': 'User not found'}), 404
    return jsonify({
        'name': p.name, 'reliability_score': p.reliability_score,
        'total_joins': p.total_joins, 'no_shows': p.no_shows,
        'on_time': p.on_time, 'late_checkins': p.late_checkins,
    }), 200

@app.route('/users', methods=['GET'])
def all_users():
    profiles = UserProfile.query.order_by(UserProfile.reliability_score.desc()).all()
    return jsonify([{
        'name': p.name, 'reliability_score': p.reliability_score,
        'total_joins': p.total_joins, 'no_shows': p.no_shows,
        'on_time': p.on_time, 'last_seen': p.last_seen.strftime('%Y-%m-%d %H:%M'),
    } for p in profiles]), 200

# ── HEALTH ────────────────────────────────────────────────────────────

@app.route('/', methods=['GET'])
def health():
    return jsonify({'status': 'SmartQueue API v2.1', 'db': 'sqlite', 'auth': 'JWT'}), 200

# ── AUTH ROUTES ───────────────────────────────────────────────────────

@app.route('/auth/register', methods=['POST'])
def register():
    d = request.get_json() or {}
    username = (d.get('username') or '').strip()
    email    = (d.get('email')    or '').strip()
    password = (d.get('password') or '').strip()
    role     = d.get('role', 'user')
    if role not in ('user', 'admin'): role = 'user'
    if not username or not email or not password:
        return jsonify({'error': 'username, email and password required'}), 400
    if User.query.filter((User.username == username) | (User.email == email)).first():
        return jsonify({'error': 'Username or email already exists'}), 409
    u = User(username=username, email=email,
             password_hash=hash_pw(password), role=role)
    db.session.add(u); db.session.commit()
    token = make_token(u.id, u.role)
    return jsonify({'token': token, 'role': u.role, 'username': u.username,
                    'message': 'Registration successful'}), 201

@app.route('/auth/login', methods=['POST'])
def login():
    d = request.get_json() or {}
    username = (d.get('username') or '').strip()
    password = (d.get('password') or '').strip()
    if not username or not password:
        return jsonify({'error': 'username and password required'}), 400
    u = User.query.filter_by(username=username, password_hash=hash_pw(password)).first()
    if not u:
        return jsonify({'error': 'Invalid credentials'}), 401
    token = make_token(u.id, u.role)
    return jsonify({'token': token, 'role': u.role, 'username': u.username,
                    'message': 'Login successful'}), 200

@app.route('/auth/me', methods=['GET'])
@token_required
def me():
    u = User.query.get(request.user_id)
    if not u: return jsonify({'error': 'User not found'}), 404
    return jsonify({'id': u.id, 'username': u.username,
                    'email': u.email, 'role': u.role}), 200

# ── PROTECTED ADMIN ROUTES (wrap existing functions) ──────────────────

@app.route('/queues/<int:qid>/remove-secure', methods=['POST'])
@admin_required
def remove_secure(qid):
    d = request.get_json() or {}
    return _remove(qid, (d.get('name') or '').strip())

@app.route('/queues/<int:qid>/serve-secure', methods=['POST'])
@admin_required
def serve_secure(qid): return serve_next(qid)

@app.route('/queues/<int:qid>/clear-secure', methods=['POST'])
@admin_required
def clear_secure(qid): return _clear(qid)

@app.route('/queues/<int:qid>/update-time-secure', methods=['POST'])
@admin_required
def update_time_secure(qid):
    return _update_time(qid, (request.get_json() or {}).get('avg_time'))

@app.route('/queues-secure', methods=['POST'])
@admin_required
def create_queue_secure():
    d = request.get_json() or {}
    if not d.get('name'):
        return jsonify({'error': 'name required'}), 400
    q = ServiceQueue(name=d['name'].strip(), description=d.get('description',''),
                     avg_service_time=float(d.get('avg_time',5)),
                     grace_minutes=float(d.get('grace_minutes', DEFAULT_GRACE)))
    db.session.add(q); db.session.commit()
    return jsonify({'id': q.id, 'name': q.name}), 201

@app.route('/stats-secure', methods=['GET'])
@admin_required
def global_stats_secure():
    queues = ServiceQueue.query.filter_by(is_active=True).all()
    result = []
    for q in queues:
        result.append({
            'queue_id': q.id, 'queue_name': q.name,
            'total_in_queue': active_entries(q.id).count(),
            'served': QueueEntry.query.filter_by(queue_id=q.id, status='served').count(),
            'missed': QueueEntry.query.filter_by(queue_id=q.id, status='missed').count(),
            'avg_time': get_rolling_avg(q.id),
        })
    return jsonify(result), 200

@app.route('/queues/<int:qid>/analytics-secure', methods=['GET'])
@admin_required
def analytics_secure(qid): return analytics(qid)

@app.route('/users-secure', methods=['GET'])
@admin_required
def users_secure(): return all_users()

# ── STARTUP ───────────────────────────────────────────────────────────

def init_app():
    with app.app_context():
        db.create_all()
        if not ServiceQueue.query.first():
            db.session.add(ServiceQueue(name='General Service',
                                        description='Default service counter'))
            db.session.commit()
        # Seed default admin
        if not User.query.filter_by(username='admin').first():
            db.session.add(User(username='admin', email='admin@smartqueue.local',
                                password_hash=hash_pw('admin123'), role='admin'))
            db.session.commit()

if __name__ == '__main__':
    init_app()
    scheduler = BackgroundScheduler()
    scheduler.add_job(check_no_shows, 'interval', seconds=30)
    scheduler.start()
    socketio.run(app, host='127.0.0.1', port=5000, debug=False, allow_unsafe_werkzeug=True)
