/* auth.js — shared JWT helpers and route guard */
'use strict';

const API = 'http://127.0.0.1:5000';

function getToken()    { return localStorage.getItem('sq_token'); }
function getRole()     { return localStorage.getItem('sq_role'); }
function getUsername() { return localStorage.getItem('sq_username'); }

function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() };
}

async function authFetch(path, opts = {}) {
  try {
    const r = await fetch(API + path, { headers: authHeaders(), ...opts });
    if (r.status === 401 || r.status === 403) { logout(); return { ok: false, data: { error: 'Session expired' } }; }
    return { ok: r.ok, status: r.status, data: await r.json() };
  } catch(e) { return { ok: false, status: 0, data: { error: 'Cannot reach server' } }; }
}

function logout() {
  localStorage.removeItem('sq_token');
  localStorage.removeItem('sq_role');
  localStorage.removeItem('sq_username');
  window.location.href = 'login.html';
}

/* Route guard — call at top of each dashboard */
function requireRole(expected) {
  const tok  = getToken();
  const role = getRole();
  if (!tok || !role) { window.location.href = 'login.html'; return false; }
  if (role !== expected) {
    alert('Access denied. You are not ' + expected + '.');
    window.location.href = role === 'admin' ? 'admin-dashboard.html' : 'user-dashboard.html';
    return false;
  }
  return true;
}

/* Shared toast */
function toast(msg, type = 'info', dur = 3500) {
  const icons = { success:'✅', error:'❌', info:'ℹ️', warn:'⚠️' };
  const c = document.getElementById('toastContainer');
  if (!c) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icons[type]||'ℹ️'}</span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transform='translateX(20px)'; t.style.transition='.3s ease'; setTimeout(()=>t.remove(),300); }, dur);
}

/* Shared helpers */
function setText(id, v) { const el=document.getElementById(id); if(el) el.textContent=v; }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/* Start clock */
function startClock() {
  const el = document.getElementById('clock');
  const tick = () => { if(el) el.textContent = new Date().toLocaleTimeString(); };
  tick(); setInterval(tick, 1000);
}
