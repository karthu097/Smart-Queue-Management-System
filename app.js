'use strict';
const API = 'http://127.0.0.1:5000';
const MAX_Q = 20;

let state = {
  queues: [], selectedQueueId: 1, currentUser: null, currentToken: null,
  queueData: [], totalPeople: 0, avgTime: 5, served: 0, missed: 0,
  apiOnline: false, countdownSecs: 0, winStart: null, winEnd: null,
};
let countdownTimer = null;
let socket = null;
let joinsChart = null, waitChart = null, servedChart = null;

/* ── INIT ─────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.panel').forEach(p => p.style.display = 'none');
  const active = document.querySelector('.panel.active');
  if (active) active.style.display = 'block';
  startClock();
  initSocket();
  loadQueues();
});

/* ── SOCKET ───────────────────────────────────────────── */
function initSocket() {
  try {
    socket = io(API, { transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      setApiStatus(true);
      socket.emit('subscribe_queue', { queue_id: state.selectedQueueId });
      socket.emit('subscribe_admin', {});
      if (state.currentUser) socket.emit('subscribe_user', { name: state.currentUser });
    });
    socket.on('disconnect', () => setApiStatus(false));
    socket.on('queue_update', onQueueUpdate);
    socket.on('stats_update', onStatsUpdate);
    socket.on('user_alert',   onUserAlert);
    socket.on('suggest_counter', onSuggestCounter);
  } catch(e) { setApiStatus(false); fallbackPolling(); }
}

function fallbackPolling() {
  loadQueues(); refreshQueue();
  setInterval(() => { loadQueues(); refreshQueue(); }, 5000);
}

/* ── SOCKET HANDLERS ──────────────────────────────────── */
function onQueueUpdate(data) {
  if (data.queue_id !== state.selectedQueueId) return;
  state.queueData   = data.queue   || [];
  state.totalPeople = data.total_people || 0;
  state.avgTime     = data.avg_time     || 5;
  renderUserPanel(); renderAdminPanel(); updateTicker(); checkAlerts();
  if (state.currentUser) updateTicketFromState();
}

function onStatsUpdate(data) {
  if (data.queue_id !== state.selectedQueueId) return;
  state.served = data.served || 0;
  state.missed = data.missed || 0;
  setText('servedDisplay', state.served);
  setText('adminServed', state.served);
  setText('adminMissed', state.missed);
}

function onUserAlert(data) {
  if (data.name !== state.currentUser) return;
  if (data.type === 'near')   toast('🔔 ' + data.message, 'warn', 6000);
  if (data.type === 'missed') { toast('⚠️ ' + data.message, 'error', 8000); resetTicket(); }
}

function onSuggestCounter(data) {
  const b = document.getElementById('suggestionBanner');
  document.getElementById('suggestionMsg').textContent =
    `⚠️ "${data.queue_name}" has ${data.count} people — consider opening a new counter`;
  b.classList.remove('hidden');
}

/* ── TAB ──────────────────────────────────────────────── */
function switchTab(tab) {
  document.querySelectorAll('.panel').forEach(p => { p.classList.remove('active'); p.style.display = 'none'; });
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  const p = document.getElementById('panel-' + tab);
  p.classList.add('active'); p.style.display = 'block';
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'analytics') loadAnalytics();
}

/* ── CLOCK ────────────────────────────────────────────── */
function startClock() {
  const el = document.getElementById('clockDisplay');
  const tick = () => { if(el) el.textContent = new Date().toLocaleTimeString(); };
  tick(); setInterval(tick, 1000);
}

/* ── API ──────────────────────────────────────────────── */
async function api(path, opts = {}) {
  try {
    const r = await fetch(API + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    return { ok: r.ok, status: r.status, data: await r.json() };
  } catch(e) { return { ok: false, status: 0, data: { error: 'Cannot reach server' } }; }
}

function setApiStatus(online) {
  state.apiOnline = online;
  const dot = document.getElementById('apiStatusDot');
  const txt = document.getElementById('apiStatusText');
  if (dot) dot.className = 'status-dot ' + (online ? 'online' : 'offline');
  if (txt) txt.textContent = online ? 'API Online' : 'API Offline';
}

/* ── LOAD QUEUES ──────────────────────────────────────── */
async function loadQueues() {
  const r = await api('/queues');
  if (!r.ok) { setApiStatus(false); return; }
  setApiStatus(true);
  state.queues = r.data;
  renderQueueSelector();
  populateQueueDropdowns();
  if (!socket || !socket.connected) refreshQueue();
}

function renderQueueSelector() {
  const grid = document.getElementById('queueSelectorGrid');
  if (!grid) return;
  if (!state.queues.length) { grid.innerHTML = '<div class="empty-state">No counters available</div>'; return; }
  grid.innerHTML = state.queues.map(q => `
    <div class="qs-card ${q.id === state.selectedQueueId ? 'selected' : ''}"
         onclick="selectQueue(${q.id})" id="qs-${q.id}">
      <div class="qs-name">${escHtml(q.name)}</div>
      <div class="qs-desc">${escHtml(q.description || 'Service counter')}</div>
      <div class="qs-count">👥 ${q.active_count} waiting</div>
    </div>`).join('');
}

function populateQueueDropdowns() {
  ['adminQueueSelect','analyticsQueueSelect'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = state.queues.map(q => `<option value="${q.id}">${escHtml(q.name)}</option>`).join('');
    if (cur) sel.value = cur;
  });
}

function selectQueue(qid) {
  if (socket) { socket.emit('unsubscribe_queue', { queue_id: state.selectedQueueId }); }
  state.selectedQueueId = qid;
  document.querySelectorAll('.qs-card').forEach(c => c.classList.remove('selected'));
  const card = document.getElementById('qs-' + qid);
  if (card) card.classList.add('selected');
  const q = state.queues.find(q => q.id === qid);
  setText('selectedQueueName', q ? q.name : '—');
  if (socket) socket.emit('subscribe_queue', { queue_id: qid });
  refreshQueue();
}

async function refreshQueue() {
  const r = await api(`/queues/${state.selectedQueueId}/queue`);
  if (!r.ok) return;
  state.queueData   = r.data.queue   || [];
  state.totalPeople = r.data.total_people || 0;
  state.avgTime     = r.data.avg_time     || 5;
  renderUserPanel(); renderAdminPanel(); updateTicker(); checkAlerts();
  if (state.currentUser) updateTicketFromState();
}

/* ── JOIN ─────────────────────────────────────────────── */
async function joinQueue() {
  const nameEl   = document.getElementById('userName');
  const errorEl  = document.getElementById('joinError');
  const btn      = document.getElementById('joinBtn');
  const spinner  = document.getElementById('joinSpinner');
  const priority = document.getElementById('priorityCheck').checked;
  const name     = nameEl.value.trim();
  if (!name) { showError(errorEl, '⚠️ Please enter your name.'); return; }
  hideEl(errorEl);
  spinner.classList.remove('hidden');
  document.getElementById('joinBtnText').textContent = 'Joining…';
  btn.disabled = true;
  const r = await api(`/queues/${state.selectedQueueId}/join`, {
    method: 'POST', body: JSON.stringify({ name, priority }),
  });
  spinner.classList.add('hidden');
  document.getElementById('joinBtnText').textContent = 'Join Queue';
  btn.disabled = false;
  if (!r.ok) { showError(errorEl, '❌ ' + (r.data.error || 'Failed to join.')); return; }
  const d = r.data;
  state.currentUser  = d.name;
  state.currentToken = d.token;
  state.countdownSecs = d.waiting_time * 60;
  state.winStart = d.window_start;
  state.winEnd   = d.window_end;
  showTicket(d);
  if (socket) socket.emit('subscribe_user', { name: d.name });
  nameEl.value = '';
  toast(`🎉 Joined at position #${d.position}`, 'success');
  loadQueues();
}

function showTicket(d) {
  setText('ticketName',     d.name);
  setText('ticketQueueName', d.queue_name || '');
  setText('ticketPosition', '#' + d.position);
  setText('ticketWait',     d.waiting_time);
  setText('winStart',       d.window_start);
  setText('winEnd',         d.window_end);
  const score = d.reliability_score || 100;
  const badge = document.getElementById('reliabilityBadge');
  if (badge) {
    badge.textContent = score;
    badge.className = 'rel-badge ' + (score >= 80 ? 'high' : score >= 50 ? 'mid' : 'low');
  }
  document.getElementById('ticketCard').classList.remove('hidden');
  document.getElementById('joinBtn').classList.add('hidden');
  startCountdown(d.waiting_time * 60);
}

function updateTicketFromState() {
  const me = state.queueData.find(u => u.name.toLowerCase() === state.currentUser.toLowerCase());
  if (!me) { resetTicket(); return; }
  setText('ticketPosition', '#' + me.position);
  setText('ticketWait',     me.waiting_time);
  if (me.window_start) setText('winStart', me.window_start);
  if (me.window_end)   setText('winEnd',   me.window_end);
  if (me.seconds_remaining !== undefined) startCountdown(me.seconds_remaining);
}

function resetTicket() {
  state.currentUser = null; state.currentToken = null;
  document.getElementById('ticketCard').classList.add('hidden');
  document.getElementById('joinBtn').classList.remove('hidden');
  document.getElementById('alertBanner').classList.add('hidden');
  clearInterval(countdownTimer);
}

/* ── COUNTDOWN ────────────────────────────────────────── */
function startCountdown(seconds) {
  clearInterval(countdownTimer);
  state.countdownSecs = Math.max(0, seconds);
  updateCountdownUI();
  countdownTimer = setInterval(() => {
    state.countdownSecs = Math.max(0, state.countdownSecs - 1);
    updateCountdownUI();
    if (state.countdownSecs === 0) clearInterval(countdownTimer);
  }, 1000);
}

function updateCountdownUI() {
  const s = state.countdownSecs;
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  const txt = h > 0 ? `${h}h\n${m}m` : m > 0 ? `${m}m\n${sec}s` : `${sec}s`;
  setText('countdownText', txt);
  const ring = document.getElementById('countdownRing');
  if (ring) {
    const circ = 163;
    const maxSecs = state.avgTime * 60 || 300;
    const offset = circ - (circ * Math.min(1, s / maxSecs));
    ring.style.strokeDashoffset = offset;
    ring.style.stroke = s < 60 ? '#22c55e' : s < 300 ? '#f59e0b' : '#6c63ff';
  }
}

/* ── LEAVE ────────────────────────────────────────────── */
async function leaveQueue() {
  if (!state.currentUser) return;
  const r = await api(`/queues/${state.selectedQueueId}/remove`, {
    method: 'POST', body: JSON.stringify({ name: state.currentUser }),
  });
  if (r.ok) { toast('👋 You left the queue.', 'info'); resetTicket(); loadQueues(); }
  else toast('❌ ' + (r.data.error || 'Could not leave.'), 'error');
}

/* ── QR MODAL ─────────────────────────────────────────── */
function showQrModal() {
  if (!state.currentToken) return;
  const modal = document.getElementById('qrModal');
  const cont  = document.getElementById('qrCodeContainer');
  const tok   = document.getElementById('qrTokenText');
  cont.innerHTML = '';
  tok.textContent = state.currentToken;
  new QRCode(cont, {
    text: JSON.stringify({ token: state.currentToken, queue_id: state.selectedQueueId }),
    width: 200, height: 200,
    colorDark: '#000', colorLight: '#fff',
    correctLevel: QRCode.CorrectLevel.H,
  });
  modal.classList.remove('hidden');
}

function closeQrModal() { document.getElementById('qrModal').classList.add('hidden'); }

async function checkinManual() {
  if (!state.currentToken) return;
  const r = await api(`/queues/${state.selectedQueueId}/checkin`, {
    method: 'POST', body: JSON.stringify({ token: state.currentToken }),
  });
  if (r.ok) {
    toast('✅ Checked in successfully!', 'success');
    closeQrModal();
  } else toast('❌ ' + (r.data.error || 'Check-in failed.'), 'error');
}

/* ── ALERTS ───────────────────────────────────────────── */
function checkAlerts() {
  const banner = document.getElementById('alertBanner');
  if (!state.currentUser) { banner.classList.add('hidden'); return; }
  const me = state.queueData.find(u => u.name.toLowerCase() === state.currentUser.toLowerCase());
  if (me && me.position <= 2) {
    setText('alertMessage', me.position === 1 ? "🚀 It's your turn! Please proceed." : '🔔 You\'re next — get ready!');
    banner.classList.remove('hidden');
  } else banner.classList.add('hidden');
}

/* ── TICKER ───────────────────────────────────────────── */
function updateTicker() {
  const el = document.getElementById('tickerText');
  if (!el) return;
  if (!state.apiOnline) { el.textContent = '⚠️ API offline'; return; }
  if (!state.queueData.length) { el.textContent = '🎉 Queue is empty — join now!'; return; }
  const names = state.queueData.slice(0,5).map(u => `#${u.position} ${u.name}`).join('  •  ');
  el.textContent = `${state.totalPeople} waiting  ·  ${names}${state.totalPeople > 5 ? '  …' : ''}`;
}

/* ── RENDER USER PANEL ────────────────────────────────── */
function renderUserPanel() {
  setText('totalPeople',    state.totalPeople);
  setText('avgTimeDisplay', state.avgTime + ' min');
  setText('liveQueueLabel', state.queues.find(q => q.id === state.selectedQueueId)?.name || '—');
  const list = document.getElementById('userQueueList');
  if (!list) return;
  if (!state.queueData.length) { list.innerHTML = '<div class="empty-state">🎉 Queue is empty</div>'; return; }
  list.innerHTML = state.queueData.map(u => {
    const isMe   = state.currentUser && u.name.toLowerCase() === state.currentUser.toLowerCase();
    const isNear = u.position <= 2, isFar = u.position > 5;
    const posC   = isNear ? 'near' : isFar ? 'far' : 'mid';
    const cls    = ['queue-item', isMe?'current-user':'', isNear?'near-turn':'', isFar?'long-wait':''].filter(Boolean).join(' ');
    const statusLabel = {'waiting':'Waiting','checkin_pending':'Check-in!','checked_in':'✓ Checked In'}[u.status] || u.status;
    return `<div class="${cls}">
      <div class="qi-pos ${posC}">${u.position}</div>
      <div class="qi-name">${escHtml(u.name)}</div>
      <div class="qi-wait">${u.waiting_time}m</div>
      <span class="qi-status ${u.status}">${statusLabel}</span>
      ${u.priority ? '<span class="qi-badge priority">⭐</span>' : ''}
      ${isMe       ? '<span class="qi-badge you">YOU</span>'     : ''}
    </div>`;
  }).join('');
}

/* ── RENDER ADMIN PANEL ───────────────────────────────── */
function renderAdminPanel() {
  setText('adminTotalQueue', state.totalPeople);
  setText('adminAvgTime',    state.avgTime + ' min');
  setText('adminQueueCount', state.totalPeople + ' people');
  const pct = Math.min(100, Math.round(state.totalPeople / MAX_Q * 100));
  const pf = document.getElementById('progressFill');
  if (pf) pf.style.width = pct + '%';
  setText('barPercent', pct + '%');
  const tbody = document.getElementById('adminTableBody');
  if (!tbody) return;
  if (!state.queueData.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No users in queue</td></tr>';
  } else {
    tbody.innerHTML = state.queueData.map(u => {
      const isNear = u.position <= 2, isMid = u.position <= 5;
      const pCls = isNear ? 'near' : isMid ? 'mid' : 'far';
      const pTxt = isNear ? '🟢 Near' : isMid ? '🟡 Waiting' : '🔴 Long';
      const sc   = u.reliability_score || 100;
      const sCls = sc >= 80 ? 'high' : sc >= 50 ? 'mid' : 'low';
      const win  = u.window_start && u.window_end ? `${u.window_start}–${u.window_end}` : '—';
      const n    = escHtml(u.name);
      return `<tr>
        <td><strong>${u.position}</strong></td>
        <td>${n}</td>
        <td>${u.priority ? '<span class="qi-badge priority">⭐</span>' : '—'}</td>
        <td><span class="status-pill ${pCls}">${pTxt}</span></td>
        <td>${u.waiting_time}m</td>
        <td style="font-size:.78rem">${win}</td>
        <td><span class="score-badge ${sCls}">${sc}</span></td>
        <td>
          <button class="remove-btn" onclick="adminRemove('${n.replace(/'/g,"\\'")}')">Remove</button>
        </td></tr>`;
    }).join('');
  }
  loadUserProfiles();
}

async function loadUserProfiles() {
  const r = await api('/users');
  if (!r.ok) return;
  const tbody = document.getElementById('userProfilesBody');
  if (!tbody) return;
  if (!r.data.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">No data</td></tr>'; return; }
  tbody.innerHTML = r.data.map(p => {
    const sc  = p.reliability_score;
    const cls = sc >= 80 ? 'high' : sc >= 50 ? 'mid' : 'low';
    return `<tr>
      <td>${escHtml(p.name)}</td>
      <td><span class="score-badge ${cls}">${Math.round(sc)}</span></td>
      <td>${p.total_joins}</td>
      <td>${p.no_shows}</td>
      <td>${p.on_time}</td></tr>`;
  }).join('');
}

/* ── ADMIN ACTIONS ────────────────────────────────────── */
function adminSwitchQueue() {
  const sel = document.getElementById('adminQueueSelect');
  if (!sel) return;
  selectQueue(parseInt(sel.value));
}

async function adminRemove(name) {
  const r = await api(`/queues/${state.selectedQueueId}/remove`, {
    method: 'POST', body: JSON.stringify({ name }),
  });
  if (r.ok) { toast(`✅ Removed "${name}"`, 'success'); loadQueues(); }
  else toast('❌ ' + (r.data.error || 'Remove failed.'), 'error');
}

async function serveNext() {
  const r = await api(`/queues/${state.selectedQueueId}/serve`, { method: 'POST' });
  if (r.ok) toast(`✅ Served: ${r.data.message}`, 'success');
  else toast('❌ ' + (r.data.error || 'Serve failed.'), 'error');
}

async function updateServiceTime() {
  const val = parseInt(document.getElementById('newAvgTime').value);
  if (!val || val < 1) { toast('⚠️ Enter a valid time.', 'warn'); return; }
  const sp = document.getElementById('updateSpinner');
  sp.classList.remove('hidden');
  const r = await api(`/queues/${state.selectedQueueId}/update-time`, {
    method: 'POST', body: JSON.stringify({ avg_time: val }),
  });
  sp.classList.add('hidden');
  if (r.ok) { toast('⏱️ Updated to ' + val + ' min', 'success'); document.getElementById('newAvgTime').value = ''; }
  else toast('❌ ' + (r.data.error || 'Update failed.'), 'error');
}

async function clearQueue() {
  if (!confirm('Clear entire queue?')) return;
  const r = await api(`/queues/${state.selectedQueueId}/clear`, { method: 'POST' });
  if (r.ok) { toast('🗑️ Queue cleared.', 'info'); resetTicket(); loadQueues(); }
  else toast('❌ Failed.', 'error');
}

async function createQueue() {
  const name = document.getElementById('newQueueName').value.trim();
  const desc = document.getElementById('newQueueDesc').value.trim();
  const time = parseFloat(document.getElementById('newQueueTime').value) || 5;
  if (!name) { toast('⚠️ Counter name required.', 'warn'); return; }
  const r = await api('/queues', {
    method: 'POST', body: JSON.stringify({ name, description: desc, avg_time: time }),
  });
  if (r.ok) {
    toast(`✅ Counter "${name}" created`, 'success');
    document.getElementById('newQueueName').value = '';
    document.getElementById('newQueueDesc').value = '';
    loadQueues();
  } else toast('❌ ' + (r.data.error || 'Create failed.'), 'error');
}

function dismissSuggestion() { document.getElementById('suggestionBanner').classList.add('hidden'); }

/* ── ANALYTICS ────────────────────────────────────────── */
async function loadAnalytics() {
  const sel = document.getElementById('analyticsQueueSelect');
  const qid = sel ? parseInt(sel.value) || state.selectedQueueId : state.selectedQueueId;
  const r   = await api(`/queues/${qid}/analytics`);
  if (!r.ok) { toast('❌ Analytics load failed.', 'error'); return; }
  const d = r.data;
  setText('kpiNoShowRate',  (d.no_show_rate || 0) + '%');
  setText('kpiTotalServed', d.total_served || 0);
  setText('kpiTotalMissed', d.total_missed || 0);
  setText('kpiPeakHour',    d.peak_hour ? d.peak_hour.slice(11,13) + ':00' : '—');
  const labels = (d.hourly || []).map(h => h.hour.slice(11,16));
  const joins  = (d.hourly || []).map(h => h.joins);
  const waits  = (d.hourly || []).map(h => +h.avg_wait.toFixed(1));
  const served = (d.hourly || []).map(h => h.served);
  const missed = (d.hourly || []).map(h => h.no_shows);
  const gridOpts = { color: 'rgba(255,255,255,0.06)' };
  const tickOpts = { color: '#8891a5', font: { size: 11 } };
  if (joinsChart) joinsChart.destroy();
  if (waitChart)  waitChart.destroy();
  if (servedChart) servedChart.destroy();
  joinsChart = new Chart(document.getElementById('joinsChart'), {
    type: 'bar',
    data: { labels, datasets: [{ label:'Joins', data:joins, backgroundColor:'rgba(108,99,255,.6)', borderRadius:4 }] },
    options: { responsive:true, plugins:{ legend:{display:false} }, scales:{ x:{grid:gridOpts,ticks:tickOpts}, y:{grid:gridOpts,ticks:tickOpts} } }
  });
  waitChart = new Chart(document.getElementById('waitChart'), {
    type: 'line',
    data: { labels, datasets: [{ label:'Avg Wait (min)', data:waits, borderColor:'#00d4aa', backgroundColor:'rgba(0,212,170,.1)', tension:.4, fill:true, pointRadius:3 }] },
    options: { responsive:true, plugins:{ legend:{display:false} }, scales:{ x:{grid:gridOpts,ticks:tickOpts}, y:{grid:gridOpts,ticks:tickOpts} } }
  });
  servedChart = new Chart(document.getElementById('servedChart'), {
    type: 'bar',
    data: { labels, datasets: [
      { label:'Served', data:served, backgroundColor:'rgba(34,197,94,.6)', borderRadius:4 },
      { label:'Missed', data:missed, backgroundColor:'rgba(255,77,109,.6)', borderRadius:4 },
    ]},
    options: { responsive:true, scales:{ x:{grid:gridOpts,ticks:tickOpts,stacked:true}, y:{grid:gridOpts,ticks:tickOpts,stacked:true} } }
  });
}

/* ── HELPERS ──────────────────────────────────────────── */
function toast(msg, type='info', dur=3500) {
  const icons = { success:'✅', error:'❌', info:'ℹ️', warn:'⚠️' };
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icons[type]||'ℹ️'}</span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transform='translateX(20px)'; t.style.transition='.3s ease'; setTimeout(()=>t.remove(),300); }, dur);
}
function setText(id, val) { const el=document.getElementById(id); if(el) el.textContent=val; }
function showError(el,msg) { el.textContent=msg; el.classList.remove('hidden'); }
function hideEl(el)        { el.classList.add('hidden'); }
function escHtml(s)        { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
