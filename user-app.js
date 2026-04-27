'use strict';
if (!requireRole('user')) throw new Error('Unauthorized');

let selQueueId = 1, curToken = null, cdTimer = null, cdSecs = 0, socket = null;
const username = getUsername();

document.addEventListener('DOMContentLoaded', () => {
  setText('welcomeText', '👋 ' + username);
  startClock();
  initSocket();
  loadQueues();
});

/* ── SOCKET ────────────────────────────────── */
function initSocket() {
  try {
    socket = io(API, { transports: ['websocket','polling'] });
    socket.on('connect', () => {
      setStatus(true);
      socket.emit('subscribe_queue', { queue_id: selQueueId });
      socket.emit('subscribe_user',  { name: username });
    });
    socket.on('disconnect', () => setStatus(false));
    socket.on('queue_update', onQueueUpdate);
    socket.on('user_alert',   onUserAlert);
  } catch(e) { setStatus(false); setInterval(refreshQueue, 5000); }
}

function setStatus(on) {
  const d = document.getElementById('apiDot');
  const t = document.getElementById('apiTxt');
  if(d) d.className = 'status-dot ' + (on ? 'online' : 'offline');
  if(t) t.textContent = on ? 'API Online' : 'API Offline';
}

function onQueueUpdate(data) {
  if (data.queue_id !== selQueueId) return;
  renderQueue(data.queue || [], data.total_people || 0, data.avg_time || 5);
  updateMyTicket(data.queue || []);
  updateTicker(data);
}

function onUserAlert(data) {
  if (data.name !== username) return;
  if (data.type === 'near')   toast('🔔 ' + data.message, 'warn', 7000);
  if (data.type === 'missed') { toast('⚠️ ' + data.message, 'error', 9000); resetTicket(); }
}

/* ── QUEUES ────────────────────────────────── */
async function loadQueues() {
  const r = await authFetch('/queues');
  if (!r.ok) return;
  const queues = r.data;
  const grid = document.getElementById('queueSelectorGrid');
  if (!queues.length) { grid.innerHTML = '<div class="empty-state">No counters available</div>'; return; }
  grid.innerHTML = queues.map(q => `
    <div class="qs-card ${q.id===selQueueId?'selected':''}" onclick="selectQueue(${q.id},'${escHtml(q.name)}')" id="qs-${q.id}">
      <div class="qs-name">${escHtml(q.name)}</div>
      <div class="qs-desc">${escHtml(q.description||'Service counter')}</div>
      <div class="qs-count">👥 ${q.active_count} waiting</div>
    </div>`).join('');
}

function selectQueue(id, name) {
  if (socket) socket.emit('unsubscribe_queue', { queue_id: selQueueId });
  selQueueId = id;
  document.querySelectorAll('.qs-card').forEach(c => c.classList.remove('selected'));
  const card = document.getElementById('qs-' + id);
  if (card) card.classList.add('selected');
  setText('selQName',   name);
  setText('liveLabel',  name);
  if (socket) socket.emit('subscribe_queue', { queue_id: id });
  refreshQueue();
}

async function refreshQueue() {
  const r = await authFetch(`/queues/${selQueueId}/queue`);
  if (!r.ok) return;
  const d = r.data;
  renderQueue(d.queue||[], d.total_people||0, d.avg_time||5);
  updateMyTicket(d.queue||[]);
}

/* ── RENDER QUEUE ──────────────────────────── */
function renderQueue(list, total, avg) {
  setText('statTotal',  total);
  setText('statAvg',    avg + ' min');
  const el = document.getElementById('queueList');
  if (!list.length) { el.innerHTML = '<div class="empty-state">🎉 Queue is empty</div>'; return; }
  el.innerHTML = list.map(u => {
    const isMe   = u.name.toLowerCase() === username.toLowerCase();
    const isNear = u.position <= 2, isFar = u.position > 5;
    const posC   = isNear ? 'near' : isFar ? 'far' : 'mid';
    const cls    = ['queue-item', isMe?'current-user':'', isNear?'near-turn':'', isFar?'long-wait':''].filter(Boolean).join(' ');
    const stLbl  = {'waiting':'Waiting','checkin_pending':'Check-in!','checked_in':'✓ In'}[u.status] || u.status;
    return `<div class="${cls}">
      <div class="qi-pos ${posC}">${u.position}</div>
      <div class="qi-name">${escHtml(u.name)}</div>
      <div class="qi-wait">${u.waiting_time}m</div>
      <span class="qi-status ${u.status}">${stLbl}</span>
      ${u.priority?'<span class="qi-badge priority">⭐</span>':''}
      ${isMe?'<span class="qi-badge you">YOU</span>':''}
    </div>`;
  }).join('');
}

/* ── TICKER ────────────────────────────────── */
function updateTicker(data) {
  const el = document.getElementById('tickerText');
  if (!el) return;
  const list = data.queue || [];
  if (!list.length) { el.textContent = '🎉 Queue is empty — join now!'; return; }
  el.textContent = `${data.total_people} waiting  ·  ${list.slice(0,4).map(u=>`#${u.position} ${u.name}`).join('  •  ')}`;
}

/* ── JOIN ──────────────────────────────────── */
async function joinQueue() {
  const errEl   = document.getElementById('joinErr');
  const btn     = document.getElementById('joinBtn');
  const spinner = document.getElementById('joinSpin');
  const priority = document.getElementById('priCheck').checked;
  errEl.classList.add('hidden');
  spinner.classList.remove('hidden');
  setText('joinBtnTxt', 'Joining…'); btn.disabled = true;
  const r = await authFetch(`/queues/${selQueueId}/join`, {
    method: 'POST', body: JSON.stringify({ name: username, priority }),
  });
  spinner.classList.add('hidden'); setText('joinBtnTxt','Join Queue'); btn.disabled = false;
  if (!r.ok) { errEl.textContent = '❌ ' + (r.data.error||'Failed'); errEl.classList.remove('hidden'); return; }
  const d = r.data;
  curToken = d.token;
  showTicket(d);
  toast(`🎉 Joined at position #${d.position}`, 'success');
  loadQueues();
}

function showTicket(d) {
  setText('tName',  username);
  setText('tQueue', d.queue_name || '');
  setText('tPos',   '#' + d.position);
  setText('tWait',  d.waiting_time);
  setText('winS',   d.window_start);
  setText('winE',   d.window_end);
  updateStatusBadge(d.status);
  updateRelBadge(d.reliability_score || 100);
  document.getElementById('ticketCard').classList.remove('hidden');
  document.getElementById('joinBtn').classList.add('hidden');
  startCd(d.waiting_time * 60);
}

function updateMyTicket(list) {
  const me = list.find(u => u.name.toLowerCase() === username.toLowerCase());
  if (!me) { resetTicket(); return; }
  setText('tPos',  '#' + me.position);
  setText('tWait', me.waiting_time);
  if (me.window_start) setText('winS', me.window_start);
  if (me.window_end)   setText('winE', me.window_end);
  updateStatusBadge(me.status);
  if (me.seconds_remaining !== undefined) startCd(me.seconds_remaining);
  // Alert
  const banner = document.getElementById('alertBanner');
  if (me.position <= 2) {
    setText('alertMsg', me.position===1 ? "🚀 It's your turn!" : '🔔 You\'re next — get ready!');
    banner.classList.remove('hidden');
  } else banner.classList.add('hidden');
}

function updateStatusBadge(status) {
  const b = document.getElementById('statusBadge');
  if (!b) return;
  b.className = 'qi-status ' + (status || 'waiting');
  b.textContent = {'waiting':'Waiting','checkin_pending':'Please Check In!','checked_in':'✓ Checked In','served':'Served'}[status] || status;
}

function updateRelBadge(score) {
  const b = document.getElementById('relBadge');
  if (!b) return;
  b.textContent = Math.round(score);
  b.className = 'rel-badge ' + (score >= 80 ? 'high' : score >= 50 ? 'mid' : 'low');
}

function resetTicket() {
  curToken = null;
  document.getElementById('ticketCard').classList.add('hidden');
  document.getElementById('joinBtn').classList.remove('hidden');
  document.getElementById('alertBanner').classList.add('hidden');
  clearInterval(cdTimer);
}

/* ── COUNTDOWN ─────────────────────────────── */
function startCd(seconds) {
  clearInterval(cdTimer);
  cdSecs = Math.max(0, seconds);
  updateCdUI();
  cdTimer = setInterval(() => { cdSecs = Math.max(0,cdSecs-1); updateCdUI(); if(!cdSecs) clearInterval(cdTimer); }, 1000);
}

function updateCdUI() {
  const h = Math.floor(cdSecs/3600), m = Math.floor((cdSecs%3600)/60), s = cdSecs%60;
  setText('cdText', h>0 ? `${h}h\n${m}m` : m>0 ? `${m}m\n${s}s` : `${s}s`);
  const ring = document.getElementById('cdRing');
  if (ring) {
    const offset = 163 - (163 * Math.min(1, cdSecs / Math.max(300, cdSecs)));
    ring.style.strokeDashoffset = offset;
    ring.style.stroke = cdSecs < 60 ? '#22c55e' : cdSecs < 300 ? '#f59e0b' : '#6c63ff';
  }
}

/* ── CHECK-IN ──────────────────────────────── */
async function doCheckin() {
  if (!curToken) { toast('⚠️ No active ticket', 'warn'); return; }
  const r = await authFetch(`/queues/${selQueueId}/checkin`, {
    method: 'POST', body: JSON.stringify({ token: curToken }),
  });
  if (r.ok) toast('✅ Checked in successfully!', 'success');
  else toast('❌ ' + (r.data.error || 'Check-in failed'), 'error');
}

/* ── QR MODAL ──────────────────────────────── */
function showQr() {
  if (!curToken) return;
  const cont = document.getElementById('qrCont');
  cont.innerHTML = '';
  new QRCode(cont, { text: JSON.stringify({token:curToken,queue_id:selQueueId}), width:200, height:200, colorDark:'#000', colorLight:'#fff', correctLevel:QRCode.CorrectLevel.H });
  setText('qrTok', curToken);
  document.getElementById('qrModal').classList.remove('hidden');
}
function closeQr() { document.getElementById('qrModal').classList.add('hidden'); }

/* ── LEAVE ─────────────────────────────────── */
async function leaveQueue() {
  const r = await authFetch(`/queues/${selQueueId}/remove`, {
    method: 'POST', body: JSON.stringify({ name: username }),
  });
  if (r.ok) { toast('👋 Left queue', 'info'); resetTicket(); loadQueues(); }
  else toast('❌ ' + (r.data.error||'Failed'), 'error');
}

/* ── STATS ─────────────────────────────────── */
async function loadStats() {
  const r = await authFetch(`/queues/${selQueueId}/stats`);
  if (!r.ok) return;
  setText('statServed', r.data.served || 0);
}
setInterval(loadStats, 10000); loadStats();
