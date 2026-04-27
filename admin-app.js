'use strict';
if (!requireRole('admin')) throw new Error('Unauthorized');

let selQueueId = 1, queues = [], socket = null;
let joinsChart = null, waitChart = null, servedChart = null;

document.addEventListener('DOMContentLoaded', () => {
  setText('welcomeText', '🛡️ ' + getUsername());
  startClock();
  initSocket();
  loadQueues();
});

/* ── TABS ──────────────────────────────────── */
function switchTab(tab) {
  ['queue','analytics','users'].forEach(t => {
    const p = document.getElementById('panel-'+t);
    const b = document.getElementById('tab-'+t);
    if(p) p.style.display = t===tab?'block':'none';
    if(b) b.classList.toggle('active', t===tab);
  });
  document.querySelectorAll('.panel').forEach(p=>{ if(!p.id.includes(tab)) p.style.display='none'; });
  document.getElementById('panel-'+tab).style.display = 'block';
  if (tab==='analytics') loadAnalytics();
  if (tab==='users') loadUsers();
}

/* ── SOCKET ────────────────────────────────── */
function initSocket() {
  try {
    socket = io(API, { transports:['websocket','polling'] });
    socket.on('connect', () => {
      setStatus(true);
      socket.emit('subscribe_queue', { queue_id: selQueueId });
      socket.emit('subscribe_admin', {});
    });
    socket.on('disconnect', () => setStatus(false));
    socket.on('queue_update', onQueueUpdate);
    socket.on('stats_update', onStatsUpdate);
    socket.on('suggest_counter', onSuggest);
  } catch(e) { setStatus(false); setInterval(refreshQueue, 5000); }
}

function setStatus(on) {
  const d=document.getElementById('apiDot'); const t=document.getElementById('apiTxt');
  if(d) d.className='status-dot '+(on?'online':'offline');
  if(t) t.textContent = on?'API Online':'API Offline';
}

function onQueueUpdate(d) {
  if (d.queue_id!==selQueueId) return;
  renderTable(d.queue||[], d.total_people||0, d.avg_time||5);
}

function onStatsUpdate(d) {
  if (d.queue_id!==selQueueId) return;
  setText('kServed', d.served||0);
  setText('kMissed', d.missed||0);
}

function onSuggest(d) {
  const b=document.getElementById('suggBanner');
  document.getElementById('suggMsg').textContent=`⚠️ "${d.queue_name}" has ${d.count} people — open a new counter!`;
  b.classList.remove('hidden');
}

/* ── QUEUES ────────────────────────────────── */
async function loadQueues() {
  const r = await authFetch('/queues');
  if (!r.ok) return;
  queues = r.data;
  const sel = document.getElementById('queueSel');
  if (sel) sel.innerHTML = queues.map(q=>`<option value="${q.id}">${escHtml(q.name)}</option>`).join('');
  const as = document.getElementById('analSel');
  if (as) as.innerHTML = queues.map(q=>`<option value="${q.id}">${escHtml(q.name)}</option>`).join('');
  refreshQueue();
}

function switchQueue() {
  const sel = document.getElementById('queueSel');
  if (!sel) return;
  if (socket) socket.emit('unsubscribe_queue', { queue_id: selQueueId });
  selQueueId = parseInt(sel.value);
  if (socket) socket.emit('subscribe_queue', { queue_id: selQueueId });
  refreshQueue();
}

async function refreshQueue() {
  const r = await authFetch(`/queues/${selQueueId}/queue`);
  if (!r.ok) return;
  renderTable(r.data.queue||[], r.data.total_people||0, r.data.avg_time||5);
  const sr = await authFetch(`/queues/${selQueueId}/stats`);
  if (sr.ok) { setText('kServed', sr.data.served||0); setText('kMissed', sr.data.missed||0); }
}

/* ── RENDER TABLE ──────────────────────────── */
function renderTable(list, total, avg) {
  setText('kInQueue', total);
  setText('kAvg',     avg+' min');
  setText('qCount',   total+' people');
  const pct = Math.min(100, Math.round(total/20*100));
  const pf = document.getElementById('progFill');
  if(pf) pf.style.width = pct+'%';
  setText('barPct', pct+'%');
  const tbody = document.getElementById('qTableBody');
  if (!tbody) return;
  if (!list.length) { tbody.innerHTML='<tr><td colspan="8" class="empty-cell">No users in queue</td></tr>'; return; }
  tbody.innerHTML = list.map(u => {
    const isNear=u.position<=2, isMid=u.position<=5;
    const pC = isNear?'near':isMid?'mid':'far';
    const pT = isNear?'🟢 Near':isMid?'🟡 Waiting':'🔴 Long';
    const sc = u.reliability_score||100;
    const sC = sc>=80?'high':sc>=50?'mid':'low';
    const win = u.window_start&&u.window_end?`${u.window_start}–${u.window_end}`:'—';
    const n   = escHtml(u.name);
    return `<tr>
      <td><strong>${u.position}</strong></td>
      <td>${n}</td>
      <td>${u.priority?'<span class="qi-badge priority">⭐</span>':'—'}</td>
      <td><span class="status-pill ${pC}">${pT}</span></td>
      <td>${u.waiting_time}m</td>
      <td style="font-size:.78rem">${win}</td>
      <td><span class="score-badge ${sC}">${Math.round(sc)}</span></td>
      <td><button class="remove-btn" onclick="removeUser('${n.replace(/'/g,"\\'")}')">Remove</button></td>
    </tr>`;
  }).join('');
}

/* ── ADMIN ACTIONS (use secure endpoints) ──── */
async function serveNext() {
  const r = await authFetch(`/queues/${selQueueId}/serve-secure`, { method:'POST' });
  if (r.ok) toast('✅ '+r.data.message, 'success');
  else toast('❌ '+(r.data.error||'Failed'), 'error');
}

async function removeUser(name) {
  const r = await authFetch(`/queues/${selQueueId}/remove-secure`, {
    method:'POST', body: JSON.stringify({ name }),
  });
  if (r.ok) toast(`✅ Removed "${name}"`, 'success');
  else toast('❌ '+(r.data.error||'Failed'), 'error');
}

async function updateTime() {
  const val = parseInt(document.getElementById('newAvg').value);
  if (!val||val<1) { toast('⚠️ Enter valid time', 'warn'); return; }
  const r = await authFetch(`/queues/${selQueueId}/update-time-secure`, {
    method:'POST', body: JSON.stringify({ avg_time: val }),
  });
  if (r.ok) { toast('⏱️ Updated to '+val+' min', 'success'); document.getElementById('newAvg').value=''; }
  else toast('❌ '+(r.data.error||'Failed'), 'error');
}

async function clearQueue() {
  if (!confirm('Clear entire queue?')) return;
  const r = await authFetch(`/queues/${selQueueId}/clear-secure`, { method:'POST' });
  if (r.ok) toast('🗑️ Queue cleared', 'info');
  else toast('❌ '+(r.data.error||'Failed'), 'error');
}

async function createQueue() {
  const name = document.getElementById('nqName').value.trim();
  const desc = document.getElementById('nqDesc').value.trim();
  const time = parseFloat(document.getElementById('nqTime').value)||5;
  if (!name) { toast('⚠️ Name required', 'warn'); return; }
  const r = await authFetch('/queues-secure', {
    method:'POST', body: JSON.stringify({ name, description:desc, avg_time:time }),
  });
  if (r.ok) {
    toast(`✅ Counter "${name}" created`, 'success');
    document.getElementById('nqName').value='';
    document.getElementById('nqDesc').value='';
    loadQueues();
  } else toast('❌ '+(r.data.error||'Failed'), 'error');
}

/* ── ANALYTICS ─────────────────────────────── */
async function loadAnalytics() {
  const sel = document.getElementById('analSel');
  const qid = sel ? parseInt(sel.value)||selQueueId : selQueueId;
  const r   = await authFetch(`/queues/${qid}/analytics-secure`);
  if (!r.ok) { toast('❌ Analytics failed', 'error'); return; }
  const d = r.data;
  setText('aNoShow',  (d.no_show_rate||0)+'%');
  setText('aServed',  d.total_served||0);
  setText('aMissed',  d.total_missed||0);
  setText('aPeak',    d.peak_hour ? d.peak_hour.slice(11,13)+':00' : '—');
  const labels  = (d.hourly||[]).map(h=>h.hour.slice(11,16));
  const joins   = (d.hourly||[]).map(h=>h.joins);
  const waits   = (d.hourly||[]).map(h=>+(h.avg_wait||0).toFixed(1));
  const served  = (d.hourly||[]).map(h=>h.served);
  const missed  = (d.hourly||[]).map(h=>h.no_shows);
  const gOpts   = { color:'rgba(255,255,255,0.06)' };
  const tOpts   = { color:'#8891a5', font:{ size:11 } };
  if(joinsChart) joinsChart.destroy();
  if(waitChart)  waitChart.destroy();
  if(servedChart) servedChart.destroy();
  joinsChart  = new Chart(document.getElementById('joinsChart'), {type:'bar',data:{labels,datasets:[{label:'Joins',data:joins,backgroundColor:'rgba(108,99,255,.6)',borderRadius:4}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{grid:gOpts,ticks:tOpts},y:{grid:gOpts,ticks:tOpts}}}});
  waitChart   = new Chart(document.getElementById('waitChart'),  {type:'line',data:{labels,datasets:[{label:'Avg Wait',data:waits,borderColor:'#00d4aa',backgroundColor:'rgba(0,212,170,.1)',tension:.4,fill:true,pointRadius:3}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{grid:gOpts,ticks:tOpts},y:{grid:gOpts,ticks:tOpts}}}});
  servedChart = new Chart(document.getElementById('servedChart'),{type:'bar',data:{labels,datasets:[{label:'Served',data:served,backgroundColor:'rgba(34,197,94,.6)',borderRadius:4},{label:'Missed',data:missed,backgroundColor:'rgba(255,77,109,.6)',borderRadius:4}]},options:{responsive:true,scales:{x:{grid:gOpts,ticks:tOpts,stacked:true},y:{grid:gOpts,ticks:tOpts,stacked:true}}}});
}

/* ── USERS ─────────────────────────────────── */
async function loadUsers() {
  const r = await authFetch('/users-secure');
  if (!r.ok) return;
  const tbody = document.getElementById('usersBody');
  if (!tbody) return;
  if (!r.data.length) { tbody.innerHTML='<tr><td colspan="6" class="empty-cell">No data</td></tr>'; return; }
  tbody.innerHTML = r.data.map(p => {
    const sc  = p.reliability_score||100;
    const cls = sc>=80?'high':sc>=50?'mid':'low';
    return `<tr><td>${escHtml(p.name)}</td><td><span class="score-badge ${cls}">${Math.round(sc)}</span></td><td>${p.total_joins}</td><td>${p.no_shows}</td><td>${p.on_time}</td><td style="font-size:.78rem">${p.last_seen||'—'}</td></tr>`;
  }).join('');
}

/* ── PANEL INIT ────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.panel').forEach(p => { p.style.display='none'; });
  const ap = document.getElementById('panel-queue');
  if(ap) ap.style.display='block';
});
