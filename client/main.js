const BASE_URL = 'http://127.0.0.1:5000';

// State
let currentUser = localStorage.getItem('queue_user') || null;
let currentPos = 0;
let currentWaitTime = 0;
let avgServiceTime = 5;
let queueList = [];

// DOM Elements
const app = {
    navUser: document.getElementById('nav-user'),
    navAdmin: document.getElementById('nav-admin'),
    userView: document.getElementById('user-view'),
    adminView: document.getElementById('admin-view'),
    
    // User View
    joinForm: document.getElementById('join-form'),
    statusCard: document.getElementById('status-card'),
    usernameInput: document.getElementById('username'),
    joinBtn: document.getElementById('join-btn'),
    leaveBtn: document.getElementById('leave-btn'),
    displayName: document.getElementById('display-name'),
    posVal: document.getElementById('pos-val'),
    timeVal: document.getElementById('time-val'),
    nearTurnAlert: document.getElementById('near-turn-alert'),
    
    // Admin View
    queueBody: document.getElementById('queue-body'),
    queueCount: document.getElementById('queue-count'),
    emptyState: document.getElementById('empty-state'),
    avgTimeInput: document.getElementById('avg-time-input'),
    updateSettingsBtn: document.getElementById('update-settings-btn')
};

// Initial Setup
const init = () => {
    setupEventListeners();
    if (currentUser) {
        showStatusView();
    }
    fetchData();
    setInterval(fetchData, 5000); // Auto-refresh every 5 seconds
};

const setupEventListeners = () => {
    // Navigation
    app.navUser.addEventListener('click', () => switchView('user'));
    app.navAdmin.addEventListener('click', () => switchView('admin'));

    // User Actions
    app.joinBtn.addEventListener('click', joinQueue);
    app.leaveBtn.addEventListener('click', leaveQueue);

    // Admin Actions
    app.updateSettingsBtn.addEventListener('click', updateSettings);
};

const switchView = (view) => {
    if (view === 'user') {
        app.navUser.classList.add('active');
        app.navAdmin.classList.remove('active');
        app.userView.classList.add('active');
        app.adminView.classList.remove('active');
    } else {
        app.navUser.classList.remove('active');
        app.navAdmin.classList.add('active');
        app.userView.classList.remove('active');
        app.adminView.classList.add('active');
    }
};

// API Functions
async function fetchData() {
    try {
        const res = await fetch(`${BASE_URL}/queue`);
        const data = await res.json();
        queueList = data.queue;
        updateUI();
    } catch (err) {
        console.error('Fetch error:', err);
    }
}

async function joinQueue() {
    const name = app.usernameInput.value.trim();
    if (!name) return showToast('Please enter your name');

    try {
        const res = await fetch(`${BASE_URL}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json();
        
        if (data.error) return showToast(data.error);

        currentUser = name;
        localStorage.setItem('queue_user', name);
        avgServiceTime = data.avg_time || avgServiceTime;
        
        showStatusView();
        fetchData();
        showToast('Successfully joined the queue!');
    } catch (err) {
        showToast('Failed to join queue');
    }
}

async function leaveQueue() {
    if (!currentUser) return;
    
    try {
        await fetch(`${BASE_URL}/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: currentUser })
        });
        
        currentUser = null;
        localStorage.removeItem('queue_user');
        app.statusCard.classList.add('hidden');
        app.joinForm.classList.remove('hidden');
        showToast('You left the queue');
        fetchData();
    } catch (err) {
        showToast('Error leaving queue');
    }
}

async function removeUser(name) {
    try {
        await fetch(`${BASE_URL}/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        if (name === currentUser) {
            currentUser = null;
            localStorage.removeItem('queue_user');
            app.statusCard.classList.add('hidden');
            app.joinForm.classList.remove('hidden');
        }
        fetchData();
        showToast(`Removed ${name}`);
    } catch (err) {
        showToast('Error removing user');
    }
}

async function updateSettings() {
    const newTime = parseFloat(app.avgTimeInput.value);
    if (isNaN(newTime) || newTime < 1) return showToast('Invalid time value');

    try {
        await fetch(`${BASE_URL}/update-time`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avg_time: newTime })
        });
        avgServiceTime = newTime;
        showToast('Settings updated');
        fetchData();
    } catch (err) {
        showToast('Error updating settings');
    }
}

// UI Updates
function updateUI() {
    // Update Admin Table
    app.queueBody.innerHTML = '';
    app.queueCount.textContent = `${queueList.length} ${queueList.length === 1 ? 'Person' : 'People'}`;
    
    if (queueList.length === 0) {
        app.emptyState.classList.remove('hidden');
    } else {
        app.emptyState.classList.add('hidden');
        queueList.forEach((name, index) => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${index + 1}</td>
                <td style="font-weight: 600">${name} ${name === currentUser ? '<span style="color: var(--primary); font-size: 0.7rem">(You)</span>' : ''}</td>
                <td><button class="remove-btn" onclick="window.removeUser('${name}')">Remove</button></td>
            `;
            app.queueBody.appendChild(row);
        });
    }

    // Update User Status if joined
    if (currentUser) {
        const pos = queueList.indexOf(currentUser);
        if (pos === -1) {
            // User was removed by admin
            currentUser = null;
            localStorage.removeItem('queue_user');
            app.statusCard.classList.add('hidden');
            app.joinForm.classList.remove('hidden');
            showToast('You have been removed from the queue');
        } else {
            currentPos = pos + 1;
            currentWaitTime = (currentPos - 1) * avgServiceTime;
            
            app.displayName.textContent = currentUser;
            app.posVal.textContent = currentPos;
            app.timeVal.textContent = currentWaitTime;

            if (currentPos <= 2) {
                app.nearTurnAlert.classList.remove('hidden');
            } else {
                app.nearTurnAlert.classList.add('hidden');
            }
        }
    }
}

function showStatusView() {
    app.joinForm.classList.add('hidden');
    app.statusCard.classList.remove('hidden');
}

function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'glass toast';
    toast.textContent = msg;
    document.getElementById('toast-container').appendChild(toast);
    
    // Simple toast style via JS for brevity
    Object.assign(toast.style, {
        padding: '1rem 1.5rem',
        marginBottom: '1rem',
        borderRadius: '12px',
        background: 'rgba(30, 41, 59, 0.9)',
        color: 'white',
        borderLeft: '4px solid var(--primary)',
        animation: 'slideIn 0.3s ease-out'
    });

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(20px)';
        toast.style.transition = 'all 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Global exposure for onclick handlers
window.removeUser = removeUser;

init();
