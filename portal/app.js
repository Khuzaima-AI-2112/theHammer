'use strict';

// ── Config ─────────────────────────────────────────────────────
// HAMMER_API_BASE: set by Cloud Run env injection or leave '' for same-origin.
// Dev: window.HAMMER_API_BASE = 'https://hammer-api-xxxx-uc.a.run.app'
const API_BASE = window.HAMMER_API_BASE
  || '__BACKEND_API_URL__';

// ── Theme Toggle ───────────────────────────────────────────────
(function() {
  const btn  = document.querySelector('[data-theme-toggle]');
  const root = document.documentElement;
  let theme  = 'dark';
  root.setAttribute('data-theme', theme);
  btn && btn.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', theme);
    btn.setAttribute('aria-label', 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' mode');
  });
})();

// ═══════════════════════════════════════════════════════════════
// AUTH GUARD  (5.13)
//
// Flow:
//   1. Show gate overlay immediately (prevents flash of unauthenticated UI)
//   2. GET /me — reads X-Goog-Authenticated-User-Email via IAP
//   3a. 200 + provisioned:true  → hide gate, reveal app, populate topbar
//   3b. 200 + provisioned:false → show "contact admin" error block
//   3c. 401                     → IAP not active (dev *.run.app direct hit);
//       show dev-mode hint but still reveal the app so local dev works.
//   3d. network error           → show retry block
//
// Sprint 21 note: when HTTPS LB + IAP are live, 401 from /me should never
// happen in production because IAP rejects the request before it reaches
// hammer-api. In dev, we get 401 because we hit *.run.app directly.
// ═══════════════════════════════════════════════════════════════

// ── Firebase Initialization ─────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyDJYNBZUMaq1EQuySZMsqKGLoj3-YdZ0Fs",
  authDomain: "thehammer.firebaseapp.com",
  projectId: "thehammer",
  storageBucket: "thehammer.firebasestorage.app",
  messagingSenderId: "282689937365",
  appId: "1:282689937365:web:d87d9a37e7a5b3a28ca75c"
};
firebase.initializeApp(firebaseConfig);

let ui = new firebaseui.auth.AuthUI(firebase.auth());
let idToken = null;
let currentUser = null;  // { email, role, userId, provisioned }

// ═══════════════════════════════════════════════════════════════
// AUTH GUARD
// ═══════════════════════════════════════════════════════════════

async function runAuthGuard() {
  const gate     = document.getElementById('authGate');
  const spinner  = document.getElementById('gateSpinner');
  const status   = document.getElementById('gateStatus');
  const appLayout = document.getElementById('appLayout');

  function showGateError(html) {
    spinner.style.display = 'none';
    status.style.display  = 'none';
    
    const existing = gate.querySelector('.gate-error-block');
    if (existing) existing.remove();

    const block = document.createElement('div');
    block.className = 'gate-error-block';
    block.innerHTML = html;
    gate.appendChild(block);
  }

  function revealApp(user) {
    currentUser = user;
    gate.classList.add('hidden');
    appLayout.classList.add('ready');
    const emailEl  = document.getElementById('userEmail');
    const avatarEl = document.getElementById('userAvatar');
    if (user && user.email) {
      emailEl.textContent  = user.email;
      avatarEl.textContent = user.email.charAt(0).toUpperCase();
    }
  }

  firebase.auth().onAuthStateChanged(async (user) => {
    if (user) {
      status.textContent = 'Verifying identity…';
      status.style.display = 'block';
      spinner.style.display = 'block';
      
      const existingError = gate.querySelector('.gate-error-block');
      if (existingError) existingError.remove();
      const existingUi = document.getElementById('firebaseui-auth-container');
      if (existingUi) existingUi.style.display = 'none';

      try {
        idToken = await user.getIdToken();
        const res = await fetch(`${API_BASE}/me`, {
          headers: { 'Authorization': `Bearer ${idToken}` }
        });

        const body = await res.json().catch(() => ({}));

        if (!res.ok) {
          showGateError(`
            <h2>Access denied</h2>
            <p>The server returned an unexpected error (HTTP ${res.status}).</p>
            <button class="btn btn-ghost" onclick="firebase.auth().signOut()">Sign Out</button>
          `);
          return;
        }

        if (!body.provisioned) {
          showGateError(`
            <h2>Account not provisioned</h2>
            <p>You're signed in as <span class="gate-email">${esc(user.email || 'unknown')}</span></p>
            <p>but this account hasn't been added to The Hammer yet.</p>
            <button class="btn btn-ghost" onclick="firebase.auth().signOut()">Sign Out</button>
          `);
          return;
        }

        if (body.role !== 'admin') {
          showGateError(`
            <h2>Insufficient role</h2>
            <p>The Admin Portal requires the <strong>admin</strong> role.</p>
            <button class="btn btn-ghost" onclick="firebase.auth().signOut()">Sign Out</button>
          `);
          return;
        }

        revealApp(body);
      } catch (err) {
        showGateError(`
          <h2>Cannot reach API</h2>
          <p>Check your network connection.</p>
          <button class="btn btn-ghost" onclick="location.reload()">Retry</button>
        `);
      }
    } else {
      idToken = null;
      spinner.style.display = 'none';
      status.style.display = 'none';
      gate.classList.remove('hidden');
      appLayout.classList.remove('ready');

      const existingError = gate.querySelector('.gate-error-block');
      if (existingError) existingError.remove();

      let uiContainer = document.getElementById('firebaseui-auth-container');
      if (!uiContainer) {
        uiContainer = document.createElement('div');
        uiContainer.id = 'firebaseui-auth-container';
        gate.appendChild(uiContainer);
      }
      uiContainer.style.display = 'block';

      ui.start('#firebaseui-auth-container', {
        signInOptions: [
          firebase.auth.GoogleAuthProvider.PROVIDER_ID,
          firebase.auth.EmailAuthProvider.PROVIDER_ID
        ],
        signInFlow: 'popup',
        callbacks: {
          signInSuccessWithAuthResult: function(authResult, redirectUrl) {
            return false;
          }
        }
      });
    }
  });
  
  // Return a dummy promise since onAuthStateChanged is async event-driven
  return new Promise(() => {}); 
}

// ── View Routing ───────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
  const view = document.getElementById(`view-${name}`);
  const btn  = document.querySelector(`[data-view="${name}"]`);
  if (view) view.classList.add('active');
  if (btn)  btn.classList.add('active');
  
  // Close mobile sidebar if open
  document.getElementById('sidebar').classList.remove('mobile-open');

  // Lazy-load data on first navigation to each view
  if (name === 'dashboard' && !dashboardLoaded) loadDashboard();
  if (name === 'users'    && allUsers.length === 0)    loadUsers();
  if (name === 'activity' && activityProjectsLoaded === false) populateActivityProjectSelect();
  if (name === 'settings') loadSettings();
}

async function createWorkspace() {
  const name = document.getElementById('wsNameInput').value.trim();
  if (!name) return showToast('Workspace name is required', 'error');
  try {
    const res = await apiFetch('/admin/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
    showToast(`Workspace '${res.workspace.name}' created! Please log in again to refresh context.`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function inviteToWorkspace() {
  const email = document.getElementById('wsInviteEmail').value.trim();
  const role = document.getElementById('wsInviteRole').value;
  if (!email) return showToast('Email is required', 'error');
  try {
    const res = await apiFetch('/admin/workspaces/invites', { method: 'POST', body: JSON.stringify({ email, role }) });
    showToast(`Invitation created! Token: ${res.invite.token}`, 'success');
    document.getElementById('wsInviteEmail').value = '';
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function joinWorkspace() {
  const token = document.getElementById('wsJoinToken').value.trim();
  if (!token) return showToast('Token is required', 'error');
  try {
    const res = await apiFetch('/admin/workspaces/join', { method: 'POST', body: JSON.stringify({ token }) });
    showToast(`Joined workspace successfully! Re-login required.`, 'success');
    document.getElementById('wsJoinToken').value = '';
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── State ──────────────────────────────────────────────────────
let allProjects   = [];
let sortKey       = 'createdAt';
let sortDir       = 'desc';
let pendingDelete = null;

let dashboardLoaded = false;
let allUsers      = [];
let usersLoaded   = false;
let addMemberCtx  = null;   // { projectId, projectName }
let removeMemberCtx = null; // { projectId, projectName, userId, displayName }

let activityFeed  = [];
let autoRefreshTimer = null;
let activityProjectsLoaded = false;
let knownTools    = new Set();

// ── API ────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };

  // #39: read the token at call time. It used to be captured once inside
  // onAuthStateChanged and reused for the life of the page, so every request
  // more than an hour after sign-in carried an expired JWT and came back 401
  // 'unauthenticated: invalid token' — most visibly on the New Project dialog,
  // with nothing to suggest that reloading would fix it. getIdToken() serves
  // from the SDK's cache and only goes to the network when the token is close
  // to expiring, so calling it per request is correct and cheap.
  const user = firebase.auth().currentUser;
  if (user) idToken = await user.getIdToken();

  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  }
  
  const res = await fetch(`${API_BASE}${path}`, {
    headers,
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  }
  if (res.status === 204) return null;
  return res.json();
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD VIEW
// ═══════════════════════════════════════════════════════════════

async function loadDashboard() {
  try {
    const stats = await apiFetch('/admin/dashboard/stats');
    document.getElementById('dashActiveProjects').textContent = stats.activeProjects ?? '—';
    document.getElementById('dashActiveUsers').textContent = stats.activeUsersToday ?? '—';
    document.getElementById('dashCaptures').textContent = stats.capturesToday ?? '—';
    document.getElementById('dashPendingReports').textContent = stats.pendingReports ?? '—';
    document.getElementById('dashPendingExports').textContent = stats.pendingExports ?? '—';
    dashboardLoaded = true;
  } catch (err) {
    showToast(`Failed to load dashboard stats: ${err.message}`, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// PROJECTS  (5.9 — kept from previous sprint, extended)
// ═══════════════════════════════════════════════════════════════

async function loadProjects() {
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true;
  renderSkeleton();
  try {
    const data = await apiFetch('/admin/projects');
    allProjects = data;
    renderProjects(filtered(allProjects));
    updateStats(allProjects);
    populateProjectFilter();       // populate users view project dropdown
    populateActivityProjectSelect(); // populate activity view project select
  } catch (err) {
    showToast(`Failed to load projects: ${err.message}`, 'error');
    renderError();
  } finally {
    btn.disabled = false;
  }
}

function filtered(list) {
  const q = (document.getElementById('searchInput').value || '').toLowerCase().trim();
  if (!q) return [...list];
  return list.filter(p => (p.name || '').toLowerCase().includes(q) ||
                          (p.projectId || '').toLowerCase().includes(q));
}

function filterProjects(q) { renderProjects(filtered(allProjects)); }

function sortTable(key) {
  if (sortKey === key) { sortDir = sortDir === 'asc' ? 'desc' : 'asc'; }
  else { sortKey = key; sortDir = 'desc'; }
  document.querySelectorAll('th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    const k = th.getAttribute('onclick').match(/'(\w+)'/);
    if (k && k[1] === sortKey) th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
  });
  renderProjects(filtered(allProjects));
}

function sorted(list) {
  return [...list].sort((a, b) => {
    let av = a[sortKey] ?? '', bv = b[sortKey] ?? '';
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
}

function renderSkeleton() {
  const tbody = document.getElementById('projectsBody');
  const empty = document.getElementById('emptyState');
  const table = document.getElementById('projectsTable');
  empty.style.display = 'none';
  table.style.display = '';
  tbody.innerHTML = Array.from({ length: 5 }, () => `
    <tr class="skeleton-row">
      <td><div class="skel-block skeleton" style="width:60%"></div></td>
      <td><div class="skel-block skeleton" style="width:40px"></div></td>
      <td><div class="skel-block skeleton" style="width:80px"></div></td>
      <td><div class="skel-block skeleton" style="width:70px"></div></td>
      <td></td>
    </tr>`).join('');
}

function renderError() {
  document.getElementById('projectsBody').innerHTML =
    `<tr><td colspan="5" style="text-align:center;padding:var(--space-8);color:var(--color-error)">
      Failed to load — check API connectivity and try refreshing.
    </td></tr>`;
}

function renderProjects(list) {
  const tbody = document.getElementById('projectsBody');
  const empty = document.getElementById('emptyState');
  const table = document.getElementById('projectsTable');
  const rows  = sorted(list);

  if (rows.length === 0 && allProjects.length === 0) {
    table.style.display = 'none'; empty.style.display = 'flex'; return;
  }
  table.style.display = ''; empty.style.display = 'none';

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:var(--space-8);color:var(--color-text-muted)">No projects match your search.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(p => {
    const created     = p.createdAt ? fmtDate(p.createdAt) : '—';
    const lastCapture = p.lastCaptureAt ? fmtRelative(p.lastCaptureAt) : '—';
    const members     = typeof p.memberCount === 'number' ? p.memberCount : 0;
    return `
    <tr data-project-id="${esc(p.projectId)}">
      <td>
        <div class="project-name-cell">
          <span class="project-name" onclick="jumpToActivity('${esc(p.projectId)}')" title="View activity">${esc(p.name)}</span>
          <span class="project-id">${esc(p.projectId)}</span>
        </div>
      </td>
      <td><span class="member-badge ${members > 0 ? 'has-members' : ''}">${members}</span></td>
      <td class="muted">${created}</td>
      <td class="muted">${lastCapture}</td>
      <td>
        <div class="actions-cell">
          <button class="btn-icon" onclick="openEditProjectModal('${esc(p.id || p.projectId)}')" aria-label="Edit project" title="Edit project">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button class="btn-icon add" onclick="openAddMemberModal('${esc(p.id || p.projectId)}','${esc(p.name)}')"
            aria-label="Add member to ${esc(p.name)}" title="Add member">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M16 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 3-1.34 3-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
          </button>
          <button class="btn-icon" onclick="openDeleteModal('${esc(p.id || p.projectId)}','${esc(p.name)}')"
            aria-label="Delete project ${esc(p.name)}" title="Delete project">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function jumpToActivity(projectId) {
  document.getElementById('activityProjectSelect').value = projectId;
  showView('activity');
  loadActivity();
}

function updateStats(list) {
  document.getElementById('statTotal').textContent   = list.length;
  const totalMembers = list.reduce((s, p) => s + (p.memberCount || 0), 0);
  document.getElementById('statMembers').textContent = totalMembers;
  const captures = list.map(p => p.lastCaptureAt).filter(Boolean).sort().reverse();
  document.getElementById('statLastCapture').textContent = captures.length ? fmtRelative(captures[0]) : '—';
}

// ── Create/Edit Modal ───────────────────────────────────────────────
let editProjectId = null;

function openCreateModal() {
  editProjectId = null;
  document.getElementById('createModalTitle').textContent = 'New Project';
  document.getElementById('projectNameInput').value = '';
  document.getElementById('projectWebhookInput').value = '';
  document.getElementById('projectLlmModelSelect').value = 'gemini-1.5-flash';
  document.getElementById('createError').textContent = '';
  document.getElementById('createSubmitBtn').disabled = false;
  openModal('createModal');
  setTimeout(() => document.getElementById('projectNameInput').focus(), 60);
}

function openEditProjectModal(id) {
  const p = allProjects.find(x => x.id === id || x.projectId === id);
  if(!p) return;
  editProjectId = p.id || p.projectId;
  document.getElementById('createModalTitle').textContent = 'Edit Project';
  document.getElementById('projectNameInput').value = p.name || '';
  document.getElementById('projectWebhookInput').value = p.webhookUrl || '';
  document.getElementById('projectLlmModelSelect').value = p.llmModel || 'gemini-1.5-flash';
  document.getElementById('createError').textContent = '';
  document.getElementById('createSubmitBtn').disabled = false;
  openModal('createModal');
  setTimeout(() => document.getElementById('projectNameInput').focus(), 60);
}

async function submitCreate() {
  const name = document.getElementById('projectNameInput').value.trim();
  const webhookUrl = document.getElementById('projectWebhookInput').value.trim();
  const llmModel = document.getElementById('projectLlmModelSelect').value;
  const errorEl = document.getElementById('createError');
  const submitBtn = document.getElementById('createSubmitBtn');
  
  if (!name) { errorEl.textContent = 'Project name is required.'; return; }
  if (name.length < 2) { errorEl.textContent = 'Name must be at least 2 characters.'; return; }
  errorEl.textContent = ''; submitBtn.disabled = true; submitBtn.textContent = 'Saving…';
  
  try {
    if (editProjectId) {
      const project = await apiFetch(`/admin/projects/${encodeURIComponent(editProjectId)}`, { 
        method: 'PATCH', 
        body: JSON.stringify({ name, webhookUrl, llmModel }) 
      });
      showToast(`Project updated.`, 'success');
      const idx = allProjects.findIndex(p => (p.id || p.projectId) === editProjectId);
      if (idx !== -1) allProjects[idx] = { ...allProjects[idx], name, webhookUrl, llmModel };
    } else {
      const project = await apiFetch('/admin/projects', { 
        method: 'POST', 
        body: JSON.stringify({ name, webhookUrl, llmModel }) 
      });
      showToast(`Project "${name}" created.`, 'success');
      allProjects.unshift({ ...project, memberCount: 0 });
    }
    closeModal('createModal');
    renderProjects(filtered(allProjects));
    updateStats(allProjects);
    populateProjectFilter();
    populateActivityProjectSelect();
  } catch (err) {
    errorEl.textContent = err.message || 'Failed to save project.';
  } finally {
    submitBtn.disabled = false; submitBtn.textContent = 'Save project';
  }
}

// ── Delete Project Modal ───────────────────────────────────────
function openDeleteModal(projectId, name) {
  pendingDelete = { projectId, name };
  document.getElementById('deleteProjectName').textContent = `"${name}"`;
  document.getElementById('deleteConfirmBtn').disabled = false;
  openModal('deleteModal');
}

async function confirmDelete() {
  if (!pendingDelete) return;
  const { projectId, name } = pendingDelete;
  const btn = document.getElementById('deleteConfirmBtn');
  btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    await apiFetch(`/admin/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
    closeModal('deleteModal');
    allProjects = allProjects.filter(p => p.projectId !== projectId);
    renderProjects(filtered(allProjects));
    updateStats(allProjects);
    populateProjectFilter();
    populateActivityProjectSelect();
    showToast(`Project "${name}" deleted.`, 'success');
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Delete'; pendingDelete = null;
  }
}

// ── Add Member Modal ───────────────────────────────────────────
function openAddMemberModal(projectId, projectName) {
  addMemberCtx = { projectId, projectName };
  document.getElementById('addMemberModalDesc').textContent = `Admit a user to "${projectName}".`;
  document.getElementById('addMemberUserId').value = '';
  document.getElementById('addMemberRole').value   = 'user';
  document.getElementById('addMemberError').textContent = '';
  document.getElementById('addMemberSubmitBtn').disabled = false;
  openModal('addMemberModal');
  setTimeout(() => document.getElementById('addMemberUserId').focus(), 60);
}

async function submitAddMember() {
  if (!addMemberCtx) return;
  const { projectId, projectName } = addMemberCtx;
  const userId  = document.getElementById('addMemberUserId').value.trim();
  const role    = document.getElementById('addMemberRole').value;
  const errorEl = document.getElementById('addMemberError');
  const btn     = document.getElementById('addMemberSubmitBtn');
  if (!userId) { errorEl.textContent = 'User ID is required.'; return; }
  errorEl.textContent = ''; btn.disabled = true; btn.textContent = 'Adding…';
  try {
    await apiFetch(`/admin/projects/${encodeURIComponent(projectId)}/members`, {
      method: 'POST', body: JSON.stringify({ userId, role })
    });
    closeModal('addMemberModal');
    showToast(`User added to "${projectName}".`, 'success');
    // Optimistic memberCount bump
    const proj = allProjects.find(p => p.projectId === projectId);
    if (proj) { proj.memberCount = (proj.memberCount || 0) + 1; }
    renderProjects(filtered(allProjects));
    updateStats(allProjects);
    if (usersLoaded) loadUsers(); // refresh users view if it was already loaded
  } catch (err) {
    errorEl.textContent = err.message || 'Failed to add member.';
  } finally {
    btn.disabled = false; btn.textContent = 'Add member';
  }
}

// ── Remove Member Modal ────────────────────────────────────────
function openRemoveMemberModal(projectId, projectName, userId, displayName) {
  removeMemberCtx = { projectId, projectName, userId, displayName };
  document.getElementById('removeMemberName').textContent    = displayName || userId;
  document.getElementById('removeMemberProject').textContent = projectName;
  document.getElementById('removeMemberConfirmBtn').disabled = false;
  openModal('removeMemberModal');
}

async function confirmRemoveMember() {
  if (!removeMemberCtx) return;
  const { projectId, projectName, userId, displayName } = removeMemberCtx;
  const btn = document.getElementById('removeMemberConfirmBtn');
  btn.disabled = true; btn.textContent = 'Removing…';
  try {
    await apiFetch(`/admin/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    closeModal('removeMemberModal');
    showToast(`${displayName || userId} removed from "${projectName}".`, 'success');
    // Optimistic memberCount decrement
    const proj = allProjects.find(p => p.projectId === projectId);
    if (proj) { proj.memberCount = Math.max(0, (proj.memberCount || 1) - 1); }
    renderProjects(filtered(allProjects));
    updateStats(allProjects);
    loadUsers(); // reload users to reflect membership change
  } catch (err) {
    showToast(`Remove failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Remove'; removeMemberCtx = null;
  }
}

// ═══════════════════════════════════════════════════════════════
// USERS VIEW  (5.11)
// ═══════════════════════════════════════════════════════════════

function populateProjectFilter() {
  const sel = document.getElementById('projectFilter');
  const cur = sel.value;
  // Keep first "All projects" option
  while (sel.options.length > 1) sel.remove(1);
  allProjects.forEach(p => {
    const opt = document.createElement('option');
    opt.value       = p.projectId;
    opt.textContent = p.name.length > 36 ? p.name.slice(0, 36) + '…' : p.name;
    sel.appendChild(opt);
  });
  if (cur) sel.value = cur;
}

function onProjectFilterChange() {
  const projectId = document.getElementById('projectFilter').value;
  const header    = document.getElementById('membershipHeader');
  const actHeader = document.getElementById('usersActionHeader');
  header.textContent  = projectId ? 'Admitted' : 'Created';
  actHeader.textContent = projectId ? '' : '';
  loadUsers();
}

async function loadUsers() {
  const projectId = document.getElementById('projectFilter').value;
  const tbody     = document.getElementById('usersBody');
  const empty     = document.getElementById('usersEmptyState');
  const table     = document.getElementById('usersTable');

  empty.style.display = 'none';
  table.style.display = '';
  tbody.innerHTML = Array.from({ length: 5 }, () => `
    <tr class="skeleton-row">
      <td><div class="skel-block skeleton" style="width:65%"></div></td>
      <td><div class="skel-block skeleton" style="width:60px"></div></td>
      <td><div class="skel-block skeleton" style="width:80px"></div></td>
      <td><div class="skel-block skeleton" style="width:60px"></div></td>
      <td></td>
    </tr>`).join('');

  try {
    const url = projectId
      ? `/admin/users?projectId=${encodeURIComponent(projectId)}`
      : '/admin/users';
    allUsers    = await apiFetch(url);
    usersLoaded = true;
    updateUserStats(allUsers);
    filterUsers();
  } catch (err) {
    showToast(`Failed to load users: ${err.message}`, 'error');
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:var(--space-8);color:var(--color-error)">
      Failed to load users. Check API connectivity.
    </td></tr>`;
  }
}

function filterUsers() {
  const q          = (document.getElementById('userSearchInput').value || '').toLowerCase().trim();
  const roleFilter = document.getElementById('roleFilter').value;
  const projectId  = document.getElementById('projectFilter').value;

  let list = allUsers;
  if (q) {
    list = list.filter(u =>
      (u.email        || '').toLowerCase().includes(q) ||
      (u.displayName  || '').toLowerCase().includes(q) ||
      (u.userId       || '').toLowerCase().includes(q)
    );
  }
  if (roleFilter) list = list.filter(u => u.role === roleFilter);

  renderUsers(list, projectId);
}

function renderUsers(list, activeProjectId) {
  const tbody = document.getElementById('usersBody');
  const empty = document.getElementById('usersEmptyState');
  const table = document.getElementById('usersTable');

  if (list.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }
  table.style.display = ''; empty.style.display = 'none';

  // Find project name for action buttons
  const proj = allProjects.find(p => p.projectId === activeProjectId);
  const projName = proj ? proj.name : '';

  tbody.innerHTML = list.map(u => {
    const initials = (u.displayName || u.email || '?').charAt(0).toUpperCase();
    const name     = esc(u.displayName || u.email || u.userId);
    const email    = esc(u.email || '');
    const roleCls  = (u.role || 'user').replace(/\s+/g, '_');
    const admitted = u.membership ? fmtDate(u.membership.admittedAt) : (u.createdAt ? fmtDate(u.createdAt) : '—');
    const lastActive = u.lastActiveAt ? fmtRelative(u.lastActiveAt) : '—';

    // Action: if project filter active, show "Remove from project" button
    const actionBtn = activeProjectId ? `
      <button class="btn-icon"
        onclick="openRemoveMemberModal('${esc(activeProjectId)}','${esc(projName)}','${esc(u.userId)}','${esc(u.displayName || u.email)}')"
        aria-label="Remove ${name} from project" title="Remove from project">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>` : '';

    return `
    <tr>
      <td>
        <div class="user-cell">
          <div class="user-cell-avatar">${initials}</div>
          <div class="user-cell-info">
            <span class="user-cell-name">${name}</span>
            <span class="user-cell-email">${email}</span>
          </div>
        </div>
      </td>
      <td>
        <select class="filter-select" style="padding: 2px 4px; height: auto;" onchange="updateUserRole('${esc(u.id || u.userId)}', this.value)">
          <option value="user" ${u.role === 'user' || !u.role ? 'selected' : ''}>user</option>
          <option value="analyst" ${u.role === 'analyst' ? 'selected' : ''}>analyst</option>
          <option value="instructional_designer" ${u.role === 'instructional_designer' ? 'selected' : ''}>instructional_designer</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option>
        </select>
      </td>
      <td class="muted">${admitted}</td>
      <td class="muted">${lastActive}</td>
      <td>
        <div style="display:flex;align-items:center;gap:var(--space-2)">
          <input type="checkbox" style="accent-color:var(--color-primary);cursor:pointer"
            onchange="toggleUserInactivity('${esc(u.id || u.userId)}', this.checked)"
            ${u.inactivityPromptEnabled ? 'checked' : ''} />
          <input type="number" class="form-input" style="width: 60px; padding: 4px; font-size: 12px"
            value="${u.inactivityTimerSeconds || 45}" min="10"
            onchange="updateUserTimer('${esc(u.id || u.userId)}', this.value)"
            ${u.inactivityPromptEnabled ? '' : 'disabled'} />
        </div>
      </td>
      <td>
        <div style="display:flex;flex-direction:column;gap:var(--space-1);font-size:10px">
          <label style="display:flex;align-items:center;gap:var(--space-1);cursor:pointer">
            <input type="checkbox" onchange="updateUserFeature('${esc(u.id || u.userId)}', 'allowPreUploadBlur', this.checked)" ${u.allowPreUploadBlur ? 'checked' : ''}> Blur
          </label>
          <label style="display:flex;align-items:center;gap:var(--space-1);cursor:pointer">
            <input type="checkbox" onchange="updateUserFeature('${esc(u.id || u.userId)}', 'instantClipboardLinks', this.checked)" ${u.instantClipboardLinks ? 'checked' : ''}> Links
          </label>
        </div>
      </td>
      <td><div class="actions-cell">${actionBtn}</div></td>
    </tr>`;
  }).join('');
}

async function toggleUserInactivity(userId, enabled) {
  try {
    await apiFetch('/admin/users/' + encodeURIComponent(userId), {
      method: 'PATCH',
      body: JSON.stringify({ inactivityPromptEnabled: enabled })
    });
    showToast('User inactivity setting updated', 'success');
    // Reload users to update disabled state of timer inputs
    loadUsers();
  } catch (err) {
    showToast('Failed to update user setting: ' + err.message, 'error');
    // Revert visually by reloading users
    loadUsers();
  }
}

async function updateUserTimer(userId, seconds) {
  try {
    await apiFetch('/admin/users/' + encodeURIComponent(userId), {
      method: 'PATCH',
      body: JSON.stringify({ inactivityTimerSeconds: parseInt(seconds, 10) })
    });
    showToast('User timer updated', 'success');
  } catch (err) {
    showToast('Failed to update user timer: ' + err.message, 'error');
    loadUsers();
  }
}

async function updateUserFeature(userId, feature, enabled) {
  try {
    const payload = {};
    payload[feature] = enabled;
    await apiFetch('/admin/users/' + encodeURIComponent(userId), {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
    showToast(`Feature ${feature} updated`, 'success');
  } catch (err) {
    showToast(`Failed to update feature: ` + err.message, 'error');
    loadUsers();
  }
}

async function updateUserRole(userId, newRole) {
  try {
    await apiFetch('/admin/users/' + encodeURIComponent(userId), {
      method: 'PATCH',
      body: JSON.stringify({ role: newRole })
    });
    showToast('User role updated successfully', 'success');
  } catch (err) {
    showToast('Failed to update user role: ' + err.message, 'error');
    loadUsers();
  }
}

function updateUserStats(list) {
  document.getElementById('statUserTotal').textContent   = list.length;
  document.getElementById('statUserAdmins').textContent  = list.filter(u => u.role === 'admin').length;
  document.getElementById('statUserAnalysts').textContent = list.filter(u => u.role === 'analyst').length;
}

// ═══════════════════════════════════════════════════════════════
// ACTIVITY VIEW  (5.12)
// ═══════════════════════════════════════════════════════════════

function populateActivityProjectSelect() {
  const sel = document.getElementById('activityProjectSelect');
  const cur = sel.value;
  while (sel.options.length > 1) sel.remove(1);
  allProjects.forEach(p => {
    const opt = document.createElement('option');
    opt.value       = p.projectId;
    opt.textContent = p.name.length > 44 ? p.name.slice(0, 44) + '…' : p.name;
    sel.appendChild(opt);
  });
  if (cur) sel.value = cur;
  activityProjectsLoaded = true;
  // Auto-select first project if none selected
  if (!sel.value && allProjects.length > 0) {
    sel.value = allProjects[0].projectId;
    loadActivity();
  }
}

async function loadActivity() {
  const projectId  = document.getElementById('activityProjectSelect').value;
  const toolFilter = document.getElementById('activityToolFilter').value;
  const tbody      = document.getElementById('activityBody');
  const empty      = document.getElementById('activityEmptyState');
  const table      = document.getElementById('activityTable');
  const lastRefEl  = document.getElementById('activityLastRefresh');

  if (!projectId) {
    table.style.display = 'none';
    empty.style.display = 'flex';
    document.getElementById('activityEmptyTitle').textContent = 'Select a project';
    document.getElementById('activityEmptyDesc').textContent  = 'Choose a project above to see its capture feed.';
    return;
  }

  empty.style.display = 'none';
  table.style.display = '';
  tbody.innerHTML = Array.from({ length: 6 }, () => `
    <tr class="skeleton-row">
      <td><div class="skel-block skeleton" style="width:80px"></div></td>
      <td><div class="skel-block skeleton" style="width:100px"></div></td>
      <td><div class="skel-block skeleton" style="width:75%"></div></td>
      <td><div class="skel-block skeleton" style="width:50px"></div></td>
      <td><div class="skel-block skeleton" style="width:60px"></div></td>
    </tr>`).join('');

  try {
    const qs  = toolFilter ? `?tool=${encodeURIComponent(toolFilter)}` : '';
    activityFeed = await apiFetch(`/admin/projects/${encodeURIComponent(projectId)}/activity${qs}`);
    lastRefEl.textContent = `Last refresh: ${new Date().toLocaleTimeString()}`;

    // Collect unique tools for the filter dropdown
    activityFeed.forEach(u => { if (u.tool) knownTools.add(u.tool); });
    populateToolFilter();

    renderActivity(activityFeed);
    updateActivityStats(activityFeed);
  } catch (err) {
    showToast(`Failed to load activity: ${err.message}`, 'error');
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:var(--space-8);color:var(--color-error)">
      Failed to load activity. Check API connectivity.
    </td></tr>`;
  }
}

function populateToolFilter() {
  const sel = document.getElementById('activityToolFilter');
  const cur = sel.value;
  while (sel.options.length > 1) sel.remove(1);
  [...knownTools].sort().forEach(t => {
    const opt = document.createElement('option');
    opt.value = t; opt.textContent = t;
    sel.appendChild(opt);
  });
  if (cur) sel.value = cur;
}

function renderActivity(list) {
  const tbody = document.getElementById('activityBody');
  const empty = document.getElementById('activityEmptyState');
  const table = document.getElementById('activityTable');

  if (list.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'flex';
    document.getElementById('activityEmptyTitle').textContent = 'No captures yet';
    document.getElementById('activityEmptyDesc').textContent  = 'Uploads will appear here once users start capturing.';
    return;
  }
  table.style.display = ''; empty.style.display = 'none';

  // Calculate per-user gaps > 45s (45000 ms)
  const sorted = [...list].sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt));
  const userLastCapture = {};
  
  sorted.forEach(u => {
    if (u.uploadedAt) {
      const time = new Date(u.uploadedAt).getTime();
      const last = userLastCapture[u.userId];
      if (last && (time - last) > 45000) {
        u.hasGap = true;
        u.gapMs = time - last;
      }
      userLastCapture[u.userId] = time;
    }
  });

  // Sort descending for display
  sorted.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

  tbody.innerHTML = sorted.map(u => {
    const tool    = u.tool ? `<span class="tool-badge">${esc(u.tool)}</span>` : '<span class="tool-badge">—</span>';
    const user    = esc(u.userId || '—');
    const path    = u.path || '—';
    const size    = u.size ? fmtBytes(u.size) : '—';
    const time    = u.uploadedAt ? fmtRelative(u.uploadedAt) : '—';
    const fullTime = u.uploadedAt ? new Date(u.uploadedAt).toLocaleString() : '';

    let trStyle = '';
    let gapIndicator = '';
    if (u.hasGap) {
      trStyle = 'border-left: 3px solid var(--color-error); background: var(--color-error-bg);';
      const gapSecs = Math.round(u.gapMs / 1000);
      gapIndicator = `<div style="font-size:10px; color:var(--color-error); font-weight: 600; margin-top:2px;">⏱ Gap: ${gapSecs}s</div>`;
    }

    return `
    <tr style="${trStyle}">
      <td>${tool}</td>
      <td class="mono" title="${user}">
        ${user.length > 22 ? user.slice(0, 22) + '…' : user}
        ${gapIndicator}
      </td>
      <td><span class="path-cell" title="${esc(path)}">${esc(path)}</span></td>
      <td><span class="size-badge">${size}</span></td>
      <td class="muted" title="${fullTime}">${time}</td>
    </tr>`;
  }).join('');
}

function updateActivityStats(list) {
  document.getElementById('statCaptureTotal').textContent = list.length;
  document.getElementById('statCaptureUsers').textContent = new Set(list.map(u => u.userId).filter(Boolean)).size;
  document.getElementById('statCaptureTools').textContent = new Set(list.map(u => u.tool).filter(Boolean)).size;
}

function toggleAutoRefresh(enabled) {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  if (enabled) {
    autoRefreshTimer = setInterval(() => {
      if (document.getElementById('view-activity').classList.contains('active')) {
        loadActivity();
      }
    }, 30_000);
  }
}

// ── Modal helpers ──────────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

document.querySelectorAll('.modal-backdrop').forEach(bd => {
  bd.addEventListener('click', e => { if (e.target === bd) closeModal(bd.id); });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-backdrop.open').forEach(m => closeModal(m.id));
});
document.getElementById('projectNameInput').addEventListener('keydown', e => { if (e.key === 'Enter') submitCreate(); });
document.getElementById('addMemberUserId').addEventListener('keydown', e => { if (e.key === 'Enter') submitAddMember(); });

document.getElementById('createCancelBtn').addEventListener('click',       () => closeModal('createModal'));
document.getElementById('createSubmitBtn').addEventListener('click',       submitCreate);
document.getElementById('deleteCancelBtn').addEventListener('click',       () => closeModal('deleteModal'));
document.getElementById('deleteConfirmBtn').addEventListener('click',      confirmDelete);
document.getElementById('addMemberCancelBtn').addEventListener('click',    () => closeModal('addMemberModal'));
document.getElementById('addMemberSubmitBtn').addEventListener('click',    submitAddMember);
document.getElementById('removeMemberCancelBtn').addEventListener('click', () => closeModal('removeMemberModal'));
document.getElementById('removeMemberConfirmBtn').addEventListener('click',confirmRemoveMember);

// ── Toast ──────────────────────────────────────────────────────
function showToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-dot"></span><span>${esc(msg)}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ── Formatters ─────────────────────────────────────────────────
function fmtDate(iso) {
  try { return new Intl.DateTimeFormat('en-CA', { year:'numeric', month:'short', day:'numeric' }).format(new Date(iso)); }
  catch (_) { return iso; }
}
function fmtRelative(iso) {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000)     return 'just now';
    if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  } catch (_) { return iso; }
}
function fmtBytes(n) {
  if (n < 1024)       return `${n} B`;
  if (n < 1048576)    return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}

// ═══════════════════════════════════════════════════════════════
// GLOBAL SETTINGS & PROFILE (5.12b, 5.12c)
// ═══════════════════════════════════════════════════════════════

let settingsLoaded = false;
async function loadSettings() {
  if (settingsLoaded) return;
  try {
    const config = await apiFetch('/config');
    document.getElementById('settingsInactivityToggle').checked = !!config.inactivityPromptEnabled;
    settingsLoaded = true;
  } catch (err) {
    showToast(`Failed to load settings: ${err.message}`, 'error');
  }
}

async function saveSettings() {
  const btn = document.getElementById('saveSettingsBtn');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const inactivityPromptEnabled = document.getElementById('settingsInactivityToggle').checked;
    await apiFetch('/config', {
      method: 'PATCH',
      body: JSON.stringify({ inactivityPromptEnabled })
    });
    showToast('Settings saved successfully.', 'success');
  } catch (err) {
    showToast(`Failed to save settings: ${err.message}`, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save settings';
  }
}

async function generateApiKey() {
  const btn = document.getElementById('generateApiKeyBtn');
  const input = document.getElementById('profileApiKey');
  btn.disabled = true;
  try {
    // Scaffold only. Backend support coming later.
    // const res = await apiFetch('/me/key', { method: 'POST' });
    input.type = 'text';
    input.value = 'api_key_scaffold_test_' + Date.now();
    showToast('New API key generated. Please copy it now.', 'success');
  } catch (err) {
    showToast(`Failed to generate key: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// REPORTS VIEW (Sprint 7)
// ═══════════════════════════════════════════════════════════════

let activeReportsPoller = null;

function populateReportProjectSelect() {
  const selGen = document.getElementById('reportProjectSelect');
  const selView = document.getElementById('reportViewProjectSelect');
  const curGen = selGen.value;
  const curView = selView.value;

  selGen.innerHTML = '';
  while (selView.options.length > 1) selView.remove(1);

  allProjects.forEach(p => {
    const opt1 = document.createElement('option');
    opt1.value = p.projectId;
    opt1.textContent = p.name;
    selGen.appendChild(opt1);

    const opt2 = document.createElement('option');
    opt2.value = p.projectId;
    opt2.textContent = p.name;
    selView.appendChild(opt2);
  });

  if (curGen) selGen.value = curGen;
  if (curView) selView.value = curView;
}

// Hook into existing loadProjects so report selects are populated
const originalLoadProjectsReportsHook = loadProjects;
loadProjects = async function() {
  await originalLoadProjectsReportsHook();
  populateReportProjectSelect();
};

function openGenerateReportModal() {
  document.getElementById('generateReportError').textContent = '';
  document.getElementById('generateReportSubmitBtn').disabled = false;
  openModal('generateReportModal');
}

async function submitGenerateReport() {
  const projectId = document.getElementById('reportProjectSelect').value;
  const reportType = document.getElementById('reportTypeSelect').value;
  const errorEl = document.getElementById('generateReportError');
  const btn = document.getElementById('generateReportSubmitBtn');

  if (!projectId) { errorEl.textContent = 'Please select a project.'; return; }

  errorEl.textContent = ''; btn.disabled = true; btn.textContent = 'Generating...';
  try {
    const res = await apiFetch('/admin/reports/generate', {
      method: 'POST',
      body: JSON.stringify({ projectId, reportType })
    });
    closeModal('generateReportModal');
    showToast('Report generation queued.', 'success');
    
    // Switch to that project view
    document.getElementById('reportViewProjectSelect').value = projectId;
    loadReports();
    startReportPolling(res.reportId);
  } catch (err) {
    errorEl.textContent = err.message || 'Failed to generate report.';
  } finally {
    btn.disabled = false; btn.textContent = 'Generate';
  }
}

async function loadReports() {
  const projectId = document.getElementById('reportViewProjectSelect').value;
  const tbody = document.getElementById('reportsBody');
  const empty = document.getElementById('reportsEmptyState');
  const table = document.getElementById('reportsTable');

  if (!projectId) {
    table.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }

  table.style.display = '';
  empty.style.display = 'none';
  tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:var(--space-8);color:var(--color-text-muted)">Loading...</td></tr>';

  try {
    const data = await apiFetch(`/admin/reports?projectId=${encodeURIComponent(projectId)}`);
    if (data.reports.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:var(--space-8);color:var(--color-text-muted)">No reports generated yet.</td></tr>';
      return;
    }

    tbody.innerHTML = data.reports.map(r => `
      <tr>
        <td style="font-weight: 500">${esc(r.reportType)}</td>
        <td><span class="role-badge ${r.status === 'done' ? 'admin' : (r.status === 'error' ? 'user' : 'analyst')}">${esc(r.status)}</span></td>
        <td class="muted">${r.createdAt ? fmtDate(r.createdAt) : '—'}</td>
        <td>
          <button class="btn btn-ghost" ${r.status !== 'done' ? 'disabled' : ''} onclick="viewReport('${r.id}', '${r.gcsPath || ''}')">View</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(`Failed to load reports: ${err.message}`, 'error');
  }
}

function startReportPolling(reportId) {
  if (activeReportsPoller) clearInterval(activeReportsPoller);
  activeReportsPoller = setInterval(async () => {
    try {
      const res = await apiFetch(`/admin/reports/${reportId}/status`);
      if (res.status === 'done' || res.status === 'error') {
        clearInterval(activeReportsPoller);
        loadReports();
      }
    } catch (err) {
      clearInterval(activeReportsPoller);
    }
  }, 2000);
}

function viewReport(reportId, gcsPath) {
  document.getElementById('reportViewerContent').textContent = `[Mockup] Viewing Report ${reportId}\nPath: ${gcsPath}\n\nIn a full implementation, the portal will fetch a signed V4 URL from the backend and display the HTML/JSON content here securely.`;
  openModal('reportViewerModal');
}

// ── Boot ───────────────────────────────────────────────────────
// Auth guard runs first; on success it reveals the app layout
// and then we boot the default data load (dashboard).
runAuthGuard().then(() => {
  if (document.getElementById('appLayout').classList.contains('ready')) {
    loadDashboard();
  }
});
