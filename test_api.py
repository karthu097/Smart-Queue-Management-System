import requests, sys, time
sys.stdout.reconfigure(encoding='utf-8')

BASE = 'http://127.0.0.1:5000'
results = []
TS = str(int(time.time()))[-5:]  # unique suffix per run

def chk(name, r, expect):
    ok = r.status_code == expect
    results.append({'test': name, 'pass': ok, 'status': r.status_code})
    mark = 'PASS' if ok else 'FAIL'
    try:
        body = r.json()
    except Exception:
        body = r.text[:80]
    print(f'[{mark}] {name} -> HTTP {r.status_code}  |  {str(body)[:100]}')

# ── HEALTH ──────────────────────────────────
chk('Health check', requests.get(BASE+'/'), 200)

# ── AUTH ────────────────────────────────────
USER = f'testuser{TS}'
EMAIL = f'{USER}@t.com'
r = requests.post(BASE+'/auth/register', json={'username':USER,'email':EMAIL,'password':'pass123','role':'user'})
chk('Register user', r, 201)
# Always get a fresh user token via login (handles pre-existing users too)
if not r.ok:
    r = requests.post(BASE+'/auth/login', json={'username':USER,'password':'pass123'})
user_token = r.json().get('token','')

r = requests.post(BASE+'/auth/login', json={'username':'admin','password':'admin123'})
chk('Login admin (default)', r, 200)
admin_token = r.json().get('token','')

r = requests.post(BASE+'/auth/login', json={'username':'testuser','password':'pass123'})
chk('Login user', r, 200)

H_a = {'Authorization': 'Bearer ' + admin_token}
H_u = {'Authorization': 'Bearer ' + user_token}

chk('Auth/me endpoint',       requests.get(BASE+'/auth/me', headers=H_a), 200)
chk('Duplicate register 409', requests.post(BASE+'/auth/register', json={'username':'admin','email':'x@x.com','password':'abc123'}), 409)
chk('Wrong password 401',     requests.post(BASE+'/auth/login', json={'username':'admin','password':'wrong'}), 401)

# ── QUEUES ──────────────────────────────────
r = requests.get(BASE+'/queues', headers=H_u)
chk('List queues', r, 200)
qid = r.json()[0]['id'] if (r.ok and r.json()) else 1
print(f'     Using queue_id={qid}')

# ── USER FEATURES ────────────────────────────
r = requests.post(BASE+f'/queues/{qid}/join', json={'name':USER}, headers=H_u)
chk('Join queue', r, 200)
checkin_tok = r.json().get('token','')

chk('View queue (user)',   requests.get(BASE+f'/queues/{qid}/queue', headers=H_u), 200)
chk('Check-in with token', requests.post(BASE+f'/queues/{qid}/checkin', json={'token': checkin_tok}, headers=H_u), 200)

# ── SECURITY ─────────────────────────────────
chk('User blocked from admin route (403)', requests.post(BASE+f'/queues/{qid}/remove-secure', json={'name':USER}, headers=H_u), 403)
chk('No token blocked (401)',              requests.post(BASE+f'/queues/{qid}/remove-secure', json={'name':USER}), 401)

# ── ADMIN FEATURES ───────────────────────────
chk('Admin serve next',     requests.post(BASE+f'/queues/{qid}/serve-secure',       headers=H_a), 200)
chk('Admin update avg time',requests.post(BASE+f'/queues/{qid}/update-time-secure', json={'avg_time':7}, headers=H_a), 200)

for n in ['Alice','Bob','Carol']:
    requests.post(BASE+f'/queues/{qid}/join', json={'name': n}, headers=H_u)
chk('Admin remove user',  requests.post(BASE+f'/queues/{qid}/remove-secure', json={'name':'Alice'}, headers=H_a), 200)
chk('Admin clear queue',  requests.post(BASE+f'/queues/{qid}/clear-secure',  headers=H_a), 200)
chk('Admin create counter',requests.post(BASE+'/queues-secure', json={'name':'VIP Counter','avg_time':3}, headers=H_a), 201)
chk('Admin analytics',    requests.get(BASE+f'/queues/{qid}/analytics-secure', headers=H_a), 200)
chk('Admin user profiles',requests.get(BASE+'/users-secure', headers=H_a), 200)
chk('Multi-queue list',   requests.get(BASE+'/queues', headers=H_u), 200)

# ── SUMMARY ──────────────────────────────────
passed = sum(1 for x in results if x['pass'])
total  = len(results)
print()
print('=' * 50)
print(f'RESULTS: {passed}/{total} tests passed')
print('=' * 50)
failed = [x for x in results if not x['pass']]
if failed:
    print('FAILED TESTS:')
    for x in failed:
        print(f'  - {x["test"]} (got HTTP {x["status"]})')
else:
    print('All tests passed!')
