'use strict';

// ── Config ─────────────────────────────────────────────────────
// HAMMER_API_BASE: set by Cloud Run env injection or leave '' for same-origin.
// Dev: window.HAMMER_API_BASE = 'https://hammer-api-xxxx-uc.a.run.app'
// #108: kept in step with backend/src/lib/models.js, which is the allowlist the
// API enforces — a value not on it is now refused by POST/PATCH /admin/projects.
const DEFAULT_LLM_MODEL = 'gemini-3.5-flash';

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

  /**
   * The way in for someone who has been invited but has no Workspace yet.
   *
   * #35: POST /admin/workspaces/join has always accepted a plain verified
   * Firebase token — creating the users record is the whole point of the route.
   * But the only box that called it sat in Workspace Settings, behind this very
   * gate, so it could only be reached by someone already provisioned, who no
   * longer needed it. An invited person had no way to let themselves in, and
   * the instructions we sent told them to "enter the invitation code" against a
   * screen that had never had a field for one. Put the field where the person
   * who needs it actually lands.
   */
  function showInviteRedemption(user) {
    showGateError(`
      <h2>One more step</h2>
      <p>You're signed in as <span class="gate-email">${esc(user.email || 'unknown')}</span>,
         but this account isn't in a Workspace yet.</p>
      <p>If you have an invitation code, enter it here.</p>
      <div class="gate-join">
        <input class="form-input" id="gateInviteToken" type="text"
               placeholder="Invitation code" autocomplete="off" spellcheck="false">
        <button class="btn btn-primary" id="gateJoinBtn">Join</button>
      </div>
      <p class="gate-join-error" id="gateJoinError" hidden></p>
      <p>No code? Ask whoever invited you — the Portal cannot email them yet.</p>
      <button class="btn btn-ghost" onclick="firebase.auth().signOut()">Sign Out</button>
    `);

    const input   = document.getElementById('gateInviteToken');
    const btn     = document.getElementById('gateJoinBtn');
    const errorEl = document.getElementById('gateJoinError');

    async function submit() {
      const token = input.value.trim();
      errorEl.hidden = true;
      if (!token) {
        errorEl.textContent = 'Enter the invitation code you were sent.';
        errorEl.hidden = false;
        return;
      }

      btn.disabled = true;
      input.disabled = true;
      btn.textContent = 'Joining…';

      try {
        await redeemInvitation(token);
        // The record now exists, so the gate has to ask /me again. A reload is
        // the honest way to do that: half the app reads its state at start-up.
        location.reload();
      } catch (err) {
        // The API's own words. It distinguishes an expired code from one
        // raised for a different address, and both are things the person can
        // act on — flattening them to "invalid" is what sends people to us.
        errorEl.textContent = err.message || 'That code was not accepted.';
        errorEl.hidden = false;
        btn.disabled = false;
        input.disabled = false;
        btn.textContent = 'Join';
        input.focus();
      }
    }

    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    input.focus();
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

        // #35: a signed-in account with no users record is the ordinary state
        // of someone who has just been invited — not a failure. It has to be
        // told apart from a real refusal *by reason*, not by status: requireAuth
        // answers 403 before /me runs, so `provisioned` is never present on
        // this path and the screen that branched on it could never appear. What
        // Chris saw instead was "unexpected error (HTTP 403)", which reads as a
        // permissions refusal against his Google account and sent him looking
        // in entirely the wrong place.
        if (res.status === 403 && body.error === 'not provisioned') {
          showInviteRedemption(user);
          return;
        }

        if (res.status === 403 && String(body.error || '').includes('insufficient role')) {
          showGateError(`
            <h2>Insufficient role</h2>
            <p>The Admin Portal requires the <strong>admin</strong> role.</p>
            <p>You're signed in as <span class="gate-email">${esc(user.email || 'unknown')}</span>.</p>
            <button class="btn btn-ghost" onclick="firebase.auth().signOut()">Sign Out</button>
          `);
          return;
        }

        if (!res.ok) {
          showGateError(`
            <h2>Access denied</h2>
            <p>The server returned an unexpected error (HTTP ${res.status}).</p>
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

      // Google only, deliberately. Every account here is created by invitation
      // and signs in with Google, so the email/password option that used to sit
      // beside it could never do anything but offer a password reset for an
      // identity that has no password — which is exactly what Chris hit on
      // 11 September, and it reads as "your email is already taken". A provider
      // the product does not actually support is worse than no choice at all.
      ui.start('#firebaseui-auth-container', {
        signInOptions: [
          firebase.auth.GoogleAuthProvider.PROVIDER_ID
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

/**
 * Redeem an invitation code. Shared by the sign-in gate (where an unprovisioned
 * person needs it) and the Workspace Settings box (where a provisioned one may
 * be joining a second Workspace) — one call site each, and they must not drift:
 * the gate is the only path for someone who cannot see Settings at all.
 *
 * Throws apiFetch's error, whose message is the API's own — 'Invitation has
 * expired' and 'Invitation email does not match authenticated user' are
 * distinct answers and both are actionable.
 */
async function redeemInvitation(token) {
  return apiFetch('/admin/workspaces/join', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

async function joinWorkspace() {
  const token = document.getElementById('wsJoinToken').value.trim();
  if (!token) return showToast('Token is required', 'error');
  try {
    await redeemInvitation(token);
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
// #41: several list routes answer `{ <key>: [...], total, nextCursor }` while
// the portal assigned the whole body to a variable it then spread or filtered.
// `list.filter is not a function` was thrown inside the caller's own try, so a
// 200 was reported as "Check API connectivity" — the one thing that was fine.
//
// A bare array is still accepted, because not every route is paginated. Anything
// else throws rather than coercing to []: a silently empty table is how this
// class of bug hides. See lessons_learned.md 52, and normaliseProjects() in the
// extension, which is this same fix on the other side.
function unwrapList(body, key) {
  if (Array.isArray(body)) return body;
  const list = body?.[key];
  if (Array.isArray(list)) return list;
  const err = new Error(`unexpected ${key} response shape`);
  // Marked so the caller's catch can tell a decode fault from a dead network.
  // Without this every failure shares one message, which is the defect in
  // lessons_learned.md 55 rule 3 — the rule this file's own commit added.
  err.isDecodeFailure = true;
  throw err;
}

/**
 * Settle a Project's identity at the door.
 *
 * The backend serialises a document's own id as `id` — the convention every
 * serialiser under backend/src/routes/admin/ follows. The portal read
 * `p.projectId` at sixteen sites, so that property was undefined on every
 * Project it ever loaded (#45). Normalising here, rather than at the sixteen
 * reads, leaves exactly one id field on an in-memory Project.
 *
 * The bug was silent because `option.value = undefined` reads back from the DOM
 * as the *string* "undefined", which is truthy, so `if (!projectId) return;`
 * passed it through and the request went out as
 * /admin/projects/undefined/activity. Hence the refusal below: a Project with
 * no usable id is a decode fault to report, not a row to render.
 *
 * Deliberately strict about the source name. Accepting `id` or `projectId` here
 * would restore the very tolerance that let this survive six defensive patches.
 */
function normaliseProject(p) {
  const id = p?.id;
  if (typeof id !== 'string' || id === '') {
    const err = new Error('unexpected project shape: no usable id');
    // Marked like unwrapList's, so the caller's catch can tell a decode fault
    // from a dead network and not blame connectivity for a 200.
    err.isDecodeFailure = true;
    throw err;
  }
  const { id: _backendId, ...rest } = p;
  return { ...rest, projectId: id };
}

/**
 * What to put in a table when a list fails to load.
 *
 * A decode fault and a dead network want opposite things from the reader: one
 * is a bug to report, the other is a thing to wait out. Sharing the string
 * "Check API connectivity" between them is what sent the last reader to check
 * the one part of the system that was working (#41).
 */
function listFailureMessage(err, what) {
  return err?.isDecodeFailure
    ? `Could not read the ${what} response — the server sent an unexpected shape. Report this; retrying will not help.`
    : `Failed to load ${what}. Check API connectivity.`;
}

async function apiFetch(path, options = {}) {
  // A FormData body (e.g. an audio recording, #88) must not carry a
  // 'Content-Type: application/json' header — fetch needs to set its own
  // multipart boundary, which a hardcoded JSON header would stomp on.
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = { ...(isFormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) };

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
    ...options,
    headers
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
    allProjects = unwrapList(await apiFetch('/admin/projects'), 'projects').map(normaliseProject);
    renderProjects(filtered(allProjects));
    updateStats(allProjects);
    populateProjectFilter();       // populate users view project dropdown
    populateActivityProjectSelect(); // populate activity view project select
  } catch (err) {
    showToast(`Failed to load projects: ${err.message}`, 'error');
    renderError(err);
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
  table.style.display = 'table';
  tbody.innerHTML = Array.from({ length: 5 }, () => `
    <tr class="skeleton-row">
      <td><div class="skel-block skeleton" style="width:60%"></div></td>
      <td><div class="skel-block skeleton" style="width:40px"></div></td>
      <td><div class="skel-block skeleton" style="width:80px"></div></td>
      <td><div class="skel-block skeleton" style="width:70px"></div></td>
      <td></td>
    </tr>`).join('');
}

function renderError(err) {
  document.getElementById('projectsBody').innerHTML =
    `<tr><td colspan="5" style="text-align:center;padding:var(--space-8);color:var(--color-error)">
      ${listFailureMessage(err, 'projects')}
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
  table.style.display = 'table'; empty.style.display = 'none';

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
          <button class="btn-icon" onclick="openEditProjectModal('${esc(p.projectId)}')" aria-label="Edit project" title="Edit project">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button class="btn-icon add" onclick="openAddMemberModal('${esc(p.projectId)}','${esc(p.name)}')"
            aria-label="Add member to ${esc(p.name)}" title="Add member">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M16 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 3-1.34 3-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
          </button>
          <button class="btn-icon" onclick="openDeleteModal('${esc(p.projectId)}','${esc(p.name)}')"
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
  document.getElementById('projectLlmModelSelect').value = DEFAULT_LLM_MODEL;
  document.getElementById('createError').textContent = '';
  document.getElementById('createSubmitBtn').disabled = false;
  openModal('createModal');
  setTimeout(() => document.getElementById('projectNameInput').focus(), 60);
}

function openEditProjectModal(id) {
  const p = allProjects.find(x => x.projectId === id);
  if(!p) return;
  editProjectId = p.projectId;
  document.getElementById('createModalTitle').textContent = 'Edit Project';
  document.getElementById('projectNameInput').value = p.name || '';
  document.getElementById('projectWebhookInput').value = p.webhookUrl || '';
  document.getElementById('projectLlmModelSelect').value = p.llmModel || DEFAULT_LLM_MODEL;
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
      const idx = allProjects.findIndex(p => p.projectId === editProjectId);
      if (idx !== -1) allProjects[idx] = { ...allProjects[idx], name, webhookUrl, llmModel };
    } else {
      const project = await apiFetch('/admin/projects', { 
        method: 'POST', 
        body: JSON.stringify({ name, webhookUrl, llmModel }) 
      });
      showToast(`Project "${name}" created.`, 'success');
      allProjects.unshift({ ...normaliseProject(project), memberCount: 0 });
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
// #116: deleting a Project is a Purge — it removes the Captures and their
// screenshots too (ADR 0015) — so the confirmation counts first and states the
// number, and the Admin types the Project's name to prove they mean it. Of five
// Projects in production three hold no Captures at all and two hold 100 and 17
// objects; the number is the whole difference between a harmless click and a
// destructive one.
function openDeleteModal(projectId, name) {
  // `counted` starts false: the Admin confirms a *counted* statement, so until
  // the number arrives there is nothing to confirm. A modal that is
  // confirmable while it still reads "its captures" is the criterion — "the
  // confirmation states the real count before the Admin confirms" — failing
  // quietly, and it is reachable by typing fast.
  pendingDelete = { projectId, name, counted: false };
  document.getElementById('deleteProjectName').textContent = `"${name}"`;
  document.getElementById('deleteCaptureCount').textContent = 'counting…';
  const input = document.getElementById('deleteConfirmName');
  input.value = '';
  input.placeholder = name;
  syncDeleteConfirmGate();
  openModal('deleteModal');
  loadDeleteCaptureCount(projectId);
}

// The count comes from the Project route rather than the list row, so it is
// current at the moment of the decision rather than as of the last list load.
async function loadDeleteCaptureCount(projectId) {
  const label = document.getElementById('deleteCaptureCount');
  try {
    const project = await apiFetch(`/admin/projects/${encodeURIComponent(projectId)}`);
    // The Admin may have cancelled and opened another Project while this was in
    // flight; a late answer must not label the wrong one.
    if (!pendingDelete || pendingDelete.projectId !== projectId) return;

    const n = project.captureCount;
    if (typeof n !== 'number') throw new Error('no captureCount in the response');

    label.textContent = n === 1 ? '1 capture' : `${n} captures`;
    pendingDelete.counted = true;
    syncDeleteConfirmGate();
  } catch (err) {
    if (!pendingDelete || pendingDelete.projectId !== projectId) return;
    // Say so rather than leaving a plausible-looking blank (lesson 69). The
    // gate stays shut: an Admin should not destroy screenshots on a
    // confirmation that could not tell them how many.
    console.warn('[portal] capture count failed:', err.message);
    label.textContent = 'an unknown number of captures';
    showToast('Could not count this project\'s captures — delete is unavailable.', 'error');
  }
}

// The gate opens only when the count is on screen and the typed name matches
// exactly. Its *behaviour* is not asserted by the portal tests — that needs a
// DOM harness (#112, Out of Scope) — so the contract test checks that this
// reads the input and drives the button, which is the half that can drift.
function syncDeleteConfirmGate() {
  const typed = document.getElementById('deleteConfirmName').value;
  const ready = !!pendingDelete && pendingDelete.counted;
  document.getElementById('deleteConfirmBtn').disabled =
    !ready || typed !== pendingDelete.name;
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
    // The gate closes again with the modal: the next Project's name has not
    // been typed yet, whatever is still in the box.
    btn.disabled = true; btn.textContent = 'Delete'; pendingDelete = null;
    document.getElementById('deleteConfirmName').value = '';
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
  table.style.display = 'table';
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
    allUsers    = unwrapList(await apiFetch(url), 'users');
    usersLoaded = true;
    updateUserStats(allUsers);
    filterUsers();
  } catch (err) {
    showToast(`Failed to load users: ${err.message}`, 'error');
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:var(--space-8);color:var(--color-error)">
      ${listFailureMessage(err, 'users')}
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
  table.style.display = 'table'; empty.style.display = 'none';

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

/**
 * Export the selected Project's Captures as one ZIP.
 *
 * apiFetch cannot serve this: it sets Content-Type: application/json and
 * parses every response body as JSON, and this response is an archive. A
 * plain <a download> cannot serve it either, because the request has to
 * carry a bearer token and an anchor sets no headers. So the bytes are
 * fetched here and handed to the browser as a blob.
 *
 * The token is read at call time, not reused from sign-in (#39).
 */
async function exportProjectCaptures() {
  const projectId  = document.getElementById('activityProjectSelect').value;
  // #75: read the same control loadActivity() reads. Without this the table
  // filters and the archive does not, and only the ZIP's contents say so.
  const toolFilter = document.getElementById('activityToolFilter').value;
  if (!projectId) {
    showToast('Select a project first', 'error');
    return;
  }

  const btn = document.getElementById('activityExportBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Exporting...';

  try {
    const user = firebase.auth().currentUser;
    if (user) idToken = await user.getIdToken();

    const qs = toolFilter ? `?tool=${encodeURIComponent(toolFilter)}` : '';
    const res = await fetch(`${API_BASE}/admin/projects/${encodeURIComponent(projectId)}/export${qs}`, {
      headers: idToken ? { Authorization: `Bearer ${idToken}` } : {}
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = toolFilter
      ? `${projectId}-${toolFilter.replace(/[^A-Za-z0-9._-]/g, '_')}-captures.zip`
      : `${projectId}-captures.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Export downloaded', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

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
  table.style.display = 'table';
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
    activityFeed = unwrapList(await apiFetch(`/admin/projects/${encodeURIComponent(projectId)}/activity${qs}`), 'uploads');
    lastRefEl.textContent = `Last refresh: ${new Date().toLocaleTimeString()}`;

    // Collect unique tools for the filter dropdown
    activityFeed.forEach(u => { if (u.tool) knownTools.add(u.tool); });
    populateToolFilter();

    renderActivity(activityFeed);
    updateActivityStats(activityFeed);
  } catch (err) {
    showToast(`Failed to load activity: ${err.message}`, 'error');
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:var(--space-8);color:var(--color-error)">
      ${listFailureMessage(err, 'activity')}
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
  table.style.display = 'table'; empty.style.display = 'none';

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
    const path    = u.gcsPath || '—';
    const size    = u.fileSizeBytes ? fmtBytes(u.fileSizeBytes) : '—';
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

// ═══════════════════════════════════════════════════════════════
// STORYBOARD DRAFT VIEW (#85)
// ═══════════════════════════════════════════════════════════════

let storyboardDraft = null;
let activeStoryboardNarrativePoller = null;

/**
 * Opens a Storyboard draft for the Project selected in the Activity view.
 * The backend route is a find-or-create, so a second click on a Project
 * that already has an open draft resumes it rather than starting over —
 * that's what makes reopening after leaving mid-curation work.
 */
async function buildStoryboard() {
  const projectId = document.getElementById('activityProjectSelect').value;
  if (!projectId) {
    showToast('Select a project first', 'error');
    return;
  }

  const btn = document.getElementById('activityBuildStoryboardBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Opening…';

  try {
    if (activeStoryboardNarrativePoller) clearInterval(activeStoryboardNarrativePoller);
    if (storyboardMediaRecorder && storyboardMediaRecorder.state === 'recording') storyboardMediaRecorder.stop();
    document.getElementById('storyboardNarrativePrompt').value = '';
    document.getElementById('storyboardRecordBtn').textContent = 'Record audio walkthrough';
    document.getElementById('storyboardVideoSection').style.display = 'none';
    delete document.getElementById('storyboardNarrativeText').dataset.loadedText;
    storyboardDraft = await apiFetch(`/admin/projects/${encodeURIComponent(projectId)}/storyboards`, { method: 'POST' });
    showView('storyboard');
    renderStoryboardDraft();
    if (storyboardDraft.narrativeStatus === 'queued' || storyboardDraft.narrativeStatus === 'generating') {
      startStoryboardNarrativePolling(storyboardDraft.id);
    }
    revealVideoSectionIfAlreadyFinalized(storyboardDraft.id, projectId);
  } catch (err) {
    showToast(`Failed to open Storyboard: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function renderStoryboardDraft() {
  const grid  = document.getElementById('storyboardGrid');
  const empty = document.getElementById('storyboardEmptyState');

  if (!storyboardDraft || storyboardDraft.captures.length === 0) {
    grid.innerHTML = '';
    grid.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }
  grid.style.display = 'grid';
  empty.style.display = 'none';

  const items = storyboardListItems(storyboardDraft.captures, storyboardDraft.workflows ?? []);

  grid.innerHTML = items.map((it, i) => it.kind === 'workflow' ? `
    <div class="storyboard-workflow${it.number ? '' : ' empty'}" data-workflow-id="${esc(it.workflow.id)}">
      <span class="storyboard-workflow-number">${it.number ? `Workflow ${it.number}` : 'Empty — not printed'}</span>
      <input class="form-input storyboard-workflow-name" type="text" maxlength="120"
             value="${esc(it.workflow.name)}" aria-label="Workflow name"
             onchange="renameStoryboardWorkflow(${it.index}, this.value)">
      <button class="btn btn-ghost" type="button" title="Move up" ${i === 0 ? 'disabled' : ''}
              onclick="moveStoryboardWorkflow(${it.index}, -1)">↑</button>
      <button class="btn btn-ghost" type="button" title="Move down" ${i === items.length - 1 ? 'disabled' : ''}
              onclick="moveStoryboardWorkflow(${it.index}, 1)">↓</button>
      <button class="btn btn-danger" type="button"
              onclick="deleteStoryboardWorkflow(${it.index})">Remove</button>
    </div>` : (c => `
    <div class="storyboard-card${c.included ? '' : ' excluded'}" data-capture-id="${esc(c.captureId)}">
      <div class="storyboard-thumb-wrap">
        <img class="storyboard-thumb" src="${esc(c.signedUrl || '')}" alt="Slide ${c.order}"
             onclick="this.classList.toggle('zoomed')">
      </div>
      <div class="storyboard-card-controls">
        <label class="storyboard-checkbox">
          <input type="checkbox" ${c.included ? 'checked' : ''}
                 onchange="toggleStoryboardCapture('${esc(c.captureId)}', this.checked)">
          Include
        </label>
        <label class="storyboard-order-label">
          Slide #
          <input class="form-input storyboard-order-input" type="number" min="1" value="${c.order}"
                 onchange="updateStoryboardOrder('${esc(c.captureId)}', this.value)">
        </label>
      </div>
      ${storyboardCaptionBox(c)}
      <textarea class="form-input storyboard-note" placeholder="Note for this slide…"
                onchange="updateStoryboardNote('${esc(c.captureId)}', this.value)">${esc(c.note)}</textarea>
      <button class="btn btn-ghost storyboard-workflow-add" type="button"
              onclick="addStoryboardWorkflow(${it.position})">Start a Workflow here</button>
    </div>`)(it.capture)).join('');

  renderStoryboardNarrative();
}

/**
 * The builder's list: frames in slide order, with the curator's Workflow
 * dividers placed in it (#126, ADR 0020).
 *
 * A divider's `position` is how many frames sit above it, ticked or not. Each
 * divider item carries `index` (its place in `workflows`, for the edit
 * handlers) and `number` — its number among the Workflows that have an
 * included frame, or null when it has none. That is the rule
 * backend/src/lib/workflows.js prints by, so the number shown here is the one
 * on the PDF, and an empty Workflow is the one the PDF leaves out.
 */
function storyboardListItems(captures, workflows) {
  const sorted = [...captures].sort((a, b) => a.order - b.order);
  const items = [];
  let next = 0;
  const placeDividersUpTo = (limit) => {
    while (next < workflows.length && workflows[next].position <= limit) {
      items.push({ kind: 'workflow', workflow: workflows[next], index: next, number: null });
      next += 1;
    }
  };
  sorted.forEach((capture, i) => {
    placeDividersUpTo(i);
    items.push({ kind: 'frame', capture, position: i });
  });
  placeDividersUpTo(Infinity);

  let number = 0;
  items.forEach((it, i) => {
    if (it.kind !== 'workflow') return;
    for (let j = i + 1; j < items.length && items[j].kind === 'frame'; j += 1) {
      if (items[j].capture.included) {
        number += 1;
        it.number = number;
        break;
      }
    }
  });
  return items;
}

/**
 * Moves divider `index` one step (`direction` -1 up, +1 down) in a list of
 * `frameCount` frames. Past a neighbouring divider in the same spot it swaps
 * with it; otherwise it steps over one frame. Returns a new list.
 */
function moveWorkflowDivider(workflows, index, direction, frameCount) {
  const list = workflows.map((w) => ({ ...w }));
  const current = list[index];
  const neighbour = list[index + direction];
  if (!current) return list;
  if (neighbour && neighbour.position === current.position) {
    list[index] = neighbour;
    list[index + direction] = current;
    return list;
  }
  const position = current.position + direction;
  if (position < 0 || position > frameCount) return list;
  current.position = position;
  return list;
}

/** Adds `divider` after any already at its position, keeping list order. Returns a new list. */
function insertWorkflowDivider(workflows, divider) {
  const at = workflows.findIndex((w) => w.position > divider.position);
  const list = workflows.map((w) => ({ ...w }));
  list.splice(at === -1 ? list.length : at, 0, { ...divider });
  return list;
}

function addStoryboardWorkflow(position) {
  if (!storyboardDraft) return;
  const id = `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  storyboardDraft.workflows = insertWorkflowDivider(storyboardDraft.workflows ?? [], { id, name: 'New Workflow', position });
  renderStoryboardDraft();
  document.querySelector(`[data-workflow-id="${id}"] .storyboard-workflow-name`)?.select();
}

function renameStoryboardWorkflow(index, name) {
  const w = storyboardDraft?.workflows?.[index];
  // A blank name is refused by the backend; keep the last one rather than
  // letting Save fail over it.
  if (w && name.trim()) w.name = name.trim();
  renderStoryboardDraft();
}

function moveStoryboardWorkflow(index, direction) {
  if (!storyboardDraft) return;
  storyboardDraft.workflows = moveWorkflowDivider(
    storyboardDraft.workflows ?? [], index, direction, storyboardDraft.captures.length);
  renderStoryboardDraft();
}

function deleteStoryboardWorkflow(index) {
  if (!storyboardDraft?.workflows) return;
  storyboardDraft.workflows = storyboardDraft.workflows.filter((_, i) => i !== index);
  renderStoryboardDraft();
}

/**
 * Reflects storyboardDraft's narrativeStatus/narrativeText/narrativeError.
 * The prompt textarea is only pre-filled from the draft the first time it
 * renders empty — typing should never be clobbered by a background poll.
 *
 * The narrative textarea is the same: it's only overwritten from the server
 * value when that value has actually changed since the last sync (tracked
 * via dataset.loadedText). A background poll re-rendering with the *same*
 * server text — the common case while an Analyst is mid-edit — leaves the
 * textarea alone. A regeneration finishing with *new* text does overwrite
 * it, which is the point (#87): regeneration explicitly replaces the
 * narrative, including an edit that hadn't been saved.
 */
function renderStoryboardNarrative() {
  const statusEl = document.getElementById('storyboardNarrativeStatus');
  const errorEl  = document.getElementById('storyboardNarrativeError');
  const textWrap = document.getElementById('storyboardNarrativeTextWrap');
  const textEl   = document.getElementById('storyboardNarrativeText');
  const btn      = document.getElementById('storyboardGenerateBtn');
  const promptEl = document.getElementById('storyboardNarrativePrompt');

  const narrativeStatus = storyboardDraft?.narrativeStatus ?? null;

  if (!promptEl.value && storyboardDraft?.narrativePrompt) {
    promptEl.value = storyboardDraft.narrativePrompt;
  }

  const busy = narrativeStatus === 'queued' || narrativeStatus === 'generating';
  btn.disabled = busy;
  btn.textContent = busy ? 'Generating…' : 'Generate narrative';

  const recordBtn = document.getElementById('storyboardRecordBtn');
  if (recordBtn.textContent !== 'Stop recording') {
    recordBtn.disabled = busy;
  }

  const statusLabels = { queued: 'Queued…', generating: 'Generating…', done: 'Done', error: 'Failed' };
  statusEl.textContent = narrativeStatus ? statusLabels[narrativeStatus] || '' : '';

  if (narrativeStatus === 'error' && storyboardDraft.narrativeError) {
    errorEl.textContent = storyboardDraft.narrativeError;
    errorEl.style.display = 'block';
  } else {
    errorEl.style.display = 'none';
  }

  if (narrativeStatus === 'done' && storyboardDraft.narrativeText != null) {
    if (textEl.dataset.loadedText !== storyboardDraft.narrativeText) {
      textEl.value = storyboardDraft.narrativeText;
      textEl.dataset.loadedText = storyboardDraft.narrativeText;
    }
    textWrap.style.display = 'block';
  } else {
    textWrap.style.display = 'none';
  }
}

/** POSTs the typed prompt, then polls GET /admin/storyboards/:id until the
 * generation settles — same "queue, then poll" shape as the Reports view.
 * Regenerating over an existing narrative is confirmed first (#87) — it
 * replaces the current text, including any unsaved edit, and that must
 * never happen as a side effect the Analyst didn't ask for. */
async function generateStoryboardNarrative() {
  if (!storyboardDraft) return;
  const prompt = document.getElementById('storyboardNarrativePrompt').value.trim();
  if (!prompt) {
    showToast('Type a prompt first', 'error');
    return;
  }

  // Edited Captions alone are enough to ask: a failed run blanks the synthesis
  // but leaves the Captions, corrected ones included (#129).
  if (storyboardDraft.narrativeText || editedCaptionCount(storyboardDraft) > 0) {
    const proceed = confirm('Regenerating replaces the current narrative, including any unsaved edits.'
      + editedCaptionsWarning(editedCaptionCount(storyboardDraft)) + ' Continue?');
    if (!proceed) return;
  }

  try {
    storyboardDraft = await apiFetch(`/admin/storyboards/${encodeURIComponent(storyboardDraft.id)}/narrative`, {
      method: 'POST',
      body: JSON.stringify({ prompt })
    });
    // The whole builder, not just the narrative section: the Caption boxes lock
    // while the words are being replaced (#129).
    renderStoryboardDraft();
    startStoryboardNarrativePolling(storyboardDraft.id);
  } catch (err) {
    showToast(`Failed to start narrative generation: ${err.message}`, 'error');
  }
}

/** PATCHes the hand-edited narrative text directly — #87's review/edit step.
 * Only reachable once a narrative exists (the textarea is hidden until
 * then), matching the backend's rejection of an edit with nothing to edit. */
async function saveStoryboardNarrativeEdit() {
  if (!storyboardDraft) return;
  const textEl = document.getElementById('storyboardNarrativeText');
  const btn = document.getElementById('storyboardNarrativeSaveEditBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    storyboardDraft = await apiFetch(`/admin/storyboards/${encodeURIComponent(storyboardDraft.id)}/narrative`, {
      method: 'PATCH',
      body: JSON.stringify({ narrativeText: textEl.value })
    });
    renderStoryboardNarrative();
    showToast('Narrative saved', 'success');
  } catch (err) {
    showToast(`Failed to save narrative edit: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function startStoryboardNarrativePolling(draftId) {
  if (activeStoryboardNarrativePoller) clearInterval(activeStoryboardNarrativePoller);
  activeStoryboardNarrativePoller = setInterval(async () => {
    try {
      const draft = await apiFetch(`/admin/storyboards/${encodeURIComponent(draftId)}`);
      if (!storyboardDraft || storyboardDraft.id !== draftId) return; // left the draft — drop the update
      const statusChanged = draft.narrativeStatus !== storyboardDraft.narrativeStatus;
      storyboardDraft = draft;
      // A change brings the Caption boxes in, or locks them (#129). Only on a
      // change, so a Note being typed doesn't lose focus every three seconds.
      // The assignment above has already replaced any unsaved curation with the
      // server's copy; the redraw shows that rather than causing it.
      if (statusChanged) renderStoryboardDraft();
      else renderStoryboardNarrative();
      if (draft.narrativeStatus === 'done' || draft.narrativeStatus === 'error') {
        clearInterval(activeStoryboardNarrativePoller);
      }
    } catch (err) {
      clearInterval(activeStoryboardNarrativePoller);
      showToast(`Failed to check narrative status: ${err.message}`, 'error');
    }
  }, 3000);
}

// ── Recorded audio as an alternate prompt input (#88) ─────────────
// The recording is transcribed server-side into narrativePrompt — the exact
// field a typed prompt uses — so generation afterward is the same "queue,
// then poll" path startStoryboardNarrativePolling already drives. There is
// no separate audio-driven UI state beyond capturing the recording itself.

let storyboardMediaRecorder = null;
let storyboardAudioChunks = [];

async function toggleStoryboardAudioRecording() {
  if (storyboardMediaRecorder && storyboardMediaRecorder.state === 'recording') {
    storyboardMediaRecorder.stop();
    return;
  }

  if (!storyboardDraft) return;
  if (storyboardDraft.narrativeText || editedCaptionCount(storyboardDraft) > 0) {
    const proceed = confirm('Recording a new walkthrough replaces the current narrative, including any unsaved edits.'
      + editedCaptionsWarning(editedCaptionCount(storyboardDraft)) + ' Continue?');
    if (!proceed) return;
  }

  const btn = document.getElementById('storyboardRecordBtn');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    storyboardAudioChunks = [];
    storyboardMediaRecorder = new MediaRecorder(stream);
    storyboardMediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) storyboardAudioChunks.push(e.data);
    };
    storyboardMediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const mimeType = storyboardMediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(storyboardAudioChunks, { type: mimeType });
      uploadStoryboardAudio(blob, mimeType);
    };
    storyboardMediaRecorder.start();
    btn.textContent = 'Stop recording';
  } catch (err) {
    showToast(`Microphone access failed: ${err.message}`, 'error');
  }
}

/** Uploads the recorded clip for transcription, then starts polling — the
 * response already carries the resulting narrativeStatus/narrativePrompt,
 * same shape POST .../narrative returns for a typed prompt. */
async function uploadStoryboardAudio(blob, mimeType) {
  if (!storyboardDraft) return;
  const btn = document.getElementById('storyboardRecordBtn');
  const label = 'Record audio walkthrough';
  btn.disabled = true;
  btn.textContent = 'Transcribing…';

  try {
    const ext = (mimeType.split('/')[1] || 'webm').split(';')[0];
    const formData = new FormData();
    formData.append('file', blob, `walkthrough.${ext}`);

    storyboardDraft = await apiFetch(`/admin/storyboards/${encodeURIComponent(storyboardDraft.id)}/narrative/audio`, {
      method: 'POST',
      body: formData
    });
    renderStoryboardDraft();
    startStoryboardNarrativePolling(storyboardDraft.id);
  } catch (err) {
    showToast(`Failed to transcribe recording: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/**
 * Finalizes the draft into a PDF (#89) — only reachable once narrativeStatus
 * is 'done' (the button lives inside storyboardNarrativeTextWrap, hidden
 * otherwise), edited via #87 or not. The result lands in the `reports`
 * collection, so there is nothing storyboard-specific to render here: the
 * existing Reports tab already lists and views it like any other report.
 */
async function finalizeStoryboardDraft() {
  if (!storyboardDraft) return;
  const btn = document.getElementById('storyboardFinalizeBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Finalizing…';

  try {
    await apiFetch(`/admin/storyboards/${encodeURIComponent(storyboardDraft.id)}/finalize`, {
      method: 'POST'
    });
    showToast('Storyboard finalized — find it in the Reports tab.', 'success');
    // "Generate video" (#90) requires a finalized PDF to already exist —
    // this session just created one, so the action is now offered.
    document.getElementById('storyboardVideoSection').style.display = 'block';
  } catch (err) {
    showToast(`Failed to finalize Storyboard: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/**
 * "Generate video" (#90) requires a finalized PDF to already exist. There's
 * no flag on the draft itself for that (#89 finalizes into a separate
 * `reports` doc, not a field on the draft) — so reopening a draft finalized
 * in an earlier session checks for one the same way the backend's own
 * refusal check does: a `reports` row for this Project with this draft's id
 * and reportType 'storyboard' at status 'done'. Failing silently (leaving
 * the section hidden) is the right degradation here — worst case the
 * Analyst re-finalizes, which finalizeStoryboardDraft() already reveals the
 * section for.
 */
async function revealVideoSectionIfAlreadyFinalized(draftId, projectId) {
  try {
    const data = await apiFetch(`/admin/reports?projectId=${encodeURIComponent(projectId)}`);
    const alreadyFinalized = (data.reports || []).some((r) =>
      r.storyboardDraftId === draftId && r.reportType === 'storyboard' && r.status === 'done'
    );
    if (alreadyFinalized) {
      document.getElementById('storyboardVideoSection').style.display = 'block';
    }
  } catch (_) {
    // Non-fatal: the button just stays hidden until the Analyst finalizes
    // again, or reloads once the Reports lookup succeeds.
  }
}

/**
 * Triggers video generation (#90) — a separate, explicit action from
 * finalizing, since Shotstack bills per render; nothing calls this except
 * this button. The result lands in the `reports` collection like the PDF,
 * so — same as finalizeStoryboardDraft() — there is nothing storyboard-
 * specific to render here: the existing Reports tab already polls and
 * displays it.
 */
async function generateStoryboardVideo() {
  if (!storyboardDraft) return;
  const btn = document.getElementById('storyboardVideoBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Starting render…';

  try {
    await apiFetch(`/admin/storyboards/${encodeURIComponent(storyboardDraft.id)}/video`, {
      method: 'POST'
    });
    showToast('Video render started — find it in the Reports tab.', 'success');
  } catch (err) {
    showToast(`Failed to start video generation: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function findStoryboardCapture(captureId) {
  return storyboardDraft?.captures.find(c => c.captureId === captureId) ?? null;
}

function toggleStoryboardCapture(captureId, included) {
  const c = findStoryboardCapture(captureId);
  if (c) c.included = included;
  // Always redrawn: an excluded slide shows no Caption box (#129), and unticking
  // the last frame under a divider makes that Workflow empty and renumbers the
  // ones after it (#126).
  renderStoryboardDraft();
}

function updateStoryboardOrder(captureId, order) {
  const c = findStoryboardCapture(captureId);
  const n = parseInt(order, 10);
  if (c && Number.isInteger(n) && n >= 1) c.order = n;
  // A divider stays at its place in the list, so a renumbered frame can move
  // into a different Workflow (#126) — redraw so the builder shows where it went.
  if (storyboardDraft?.workflows?.length) renderStoryboardDraft();
}

function updateStoryboardNote(captureId, note) {
  const c = findStoryboardCapture(captureId);
  if (c) c.note = note;
}

// ── Captions (#129) ────────────────────────────────────────────────
// Browser code cannot require backend/src/lib/models.js, so the budget is
// written twice; storyboard-captions.test.js holds the two copies equal.
const STORYBOARD_CAPTION_MAX_WORDS = 45;

/** Words in a Caption, counted the way the server counts them. */
function captionWordCount(text) {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * What a card's Caption box shows: `editable` once the narrative is done,
 * `readonly` while it is being replaced, `hidden` otherwise. After a failed run
 * the stored Captions are the previous run's leftovers, and an excluded slide
 * is neither printed nor narrated, so neither has anything to correct.
 */
function captionBoxState(draft, capture) {
  if (!capture.included) return 'hidden';
  if (draft.narrativeStatus === 'done') return 'editable';
  if (draft.narrativeStatus === 'queued' || draft.narrativeStatus === 'generating') return 'readonly';
  return 'hidden';
}

/** The stored Caption for one Capture, or null when it has none. */
function storedCaption(captureId) {
  return (storyboardDraft?.narrativeCaptions ?? []).find(n => n.captureId === captureId) ?? null;
}

/**
 * One card's Caption box (#129). It saves by itself when the Analyst leaves it,
 * unlike the Note below it, which waits for Save: a whole-draft save from a
 * stale page would overwrite a regeneration that finished in the background.
 */
function storyboardCaptionBox(c) {
  const state = captionBoxState(storyboardDraft, c);
  if (state === 'hidden') return '';

  const stored = storedCaption(c.captureId);
  const caption = stored?.caption ?? '';
  const words = captionWordCount(caption);
  return `
      <div class="storyboard-caption">
        <div class="storyboard-caption-head">
          <span>Caption${state === 'editable' ? ' · saves automatically' : ''}</span>
          <span class="storyboard-caption-edited" ${stored?.edited ? '' : 'hidden'}>Edited</span>
          <span class="storyboard-caption-count${words > STORYBOARD_CAPTION_MAX_WORDS ? ' over' : ''}">${words} / ${STORYBOARD_CAPTION_MAX_WORDS}</span>
        </div>
        <textarea class="form-input storyboard-caption-text" aria-label="Caption for slide ${c.order}"
                  placeholder="No caption yet. Write one…" ${state === 'readonly' ? 'readonly' : ''}
                  oninput="updateStoryboardCaptionCount(this)"
                  onchange="saveStoryboardCaption('${esc(c.captureId)}', this)">${esc(caption)}</textarea>
      </div>`;
}

/** Live word count under the budget, as the Analyst types. */
function updateStoryboardCaptionCount(textEl) {
  const countEl = textEl.closest('.storyboard-caption').querySelector('.storyboard-caption-count');
  const words = captionWordCount(textEl.value);
  countEl.textContent = `${words} / ${STORYBOARD_CAPTION_MAX_WORDS}`;
  countEl.classList.toggle('over', words > STORYBOARD_CAPTION_MAX_WORDS);
}

/**
 * Saves one Caption when the Analyst leaves its box. Only the Captions are
 * taken from the response: Notes, ticks and slide numbers on this page may be
 * unsaved, and replacing the whole draft would drop them.
 */
async function saveStoryboardCaption(captureId, textEl) {
  if (!storyboardDraft) return;
  const stored = storedCaption(captureId);
  const caption = textEl.value.trim();

  if (caption === (stored?.caption ?? '')) return;
  if (caption === '') {
    textEl.value = stored?.caption ?? '';
    updateStoryboardCaptionCount(textEl);
    showToast('A caption can be rewritten but not left blank', 'error');
    return;
  }
  if (captionWordCount(caption) > STORYBOARD_CAPTION_MAX_WORDS) {
    showToast(`A caption is ${STORYBOARD_CAPTION_MAX_WORDS} words at most. Shorten it to save.`, 'error');
    return;
  }

  try {
    const updated = await apiFetch(`/admin/storyboards/${encodeURIComponent(storyboardDraft.id)}/captions`, {
      method: 'PATCH',
      body: JSON.stringify({ captureId, caption })
    });
    storyboardDraft.narrativeCaptions = updated.narrativeCaptions;
    setHidden(textEl.closest('.storyboard-caption').querySelector('.storyboard-caption-edited'), false);
    showToast('Caption saved', 'success');
  } catch (err) {
    showToast(`Failed to save caption: ${err.message}`, 'error');
  }
}

/** Corrected Captions a regeneration would replace, on any slide: an excluded
 * slide's Caption is replaced too, even though its box is hidden. */
function editedCaptionCount(draft) {
  return (draft?.narrativeCaptions ?? []).filter(c => c.edited).length;
}

/** The sentence a replace-the-narrative confirm adds, so a correction is never
 * discarded silently (#129). Empty when there is nothing to lose. */
function editedCaptionsWarning(count) {
  if (count === 0) return '';
  return ` ${count} ${count === 1 ? 'caption' : 'captions'} you edited by hand will be replaced.`;
}

/**
 * PATCH /admin/storyboards/:id requires every Capture the draft was
 * created with in the payload, so the whole local set is sent back each
 * time — not just the row that changed.
 */
async function saveStoryboardDraft() {
  if (!storyboardDraft) return;
  const btn = document.getElementById('storyboardSaveBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const captures = storyboardDraft.captures.map(c => ({
      captureId: c.captureId,
      order:     c.order,
      included:  c.included,
      note:      c.note
    }));
    storyboardDraft = await apiFetch(`/admin/storyboards/${encodeURIComponent(storyboardDraft.id)}`, {
      method: 'PATCH',
      // The dividers go with every save, like the frames: they are curation,
      // and an empty list is how the last one is deleted (#126).
      body: JSON.stringify({ captures, workflows: storyboardDraft.workflows ?? [] })
    });
    renderStoryboardDraft();
    showToast('Storyboard saved', 'success');
  } catch (err) {
    showToast(`Failed to save Storyboard: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
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
document.getElementById('deleteConfirmName').addEventListener('input',     syncDeleteConfirmGate);
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

// ── Storyboard picker for OCR Reports (#96, ADR 0017) ──────────
// An OCR Report is generated for a Storyboard, not for a Project: the Analyst
// has already decided which Captures belong together and in what order.

const OCR_REPORT_TYPE = 'storyboard_changes';

/**
 * The cap the backend applies, sent with the Storyboard list.
 *
 * Deliberately not a constant here. ADR 0017 puts this number in
 * lib/models.js, and a hardcoded copy would keep telling Analysts "the first
 * 20" after the backend began enforcing something else — a wrong statement
 * about what the Report examined, which is the class of defect this whole
 * ticket is about. Null until the list has been fetched.
 */
let ocrMaxPairs = null;

/**
 * Reveal or hide the picker.
 *
 * `el.hidden`, not `el.style.display` — clearing an inline style to reveal is
 * the pattern lesson 59 forbids, and #50 has now removed it from the twelve
 * sites that carried it.
 *
 * `hidden` is the better tool only where no author rule sets a `display` on the
 * element: the attribute's `display: none` comes from the user agent
 * stylesheet, so any class rule beats it. That holds for this picker and not
 * for, say, `.storyboard-grid`, which is why the sites #50 fixed assign an
 * explicit value rather than all moving here.
 */
function setHidden(el, hidden) {
  el.hidden = hidden;
}

/** How much of this Storyboard a Report would actually examine. */
function storyboardCoverageText(storyboard) {
  const included = storyboard.includedCaptures;
  if (included < 2) {
    return 'This Storyboard has fewer than two included Captures, so there is nothing to compare.';
  }
  const pairs = included - 1;
  const plural = pairs === 1 ? '' : 's';
  // Without a cap from the server, say what is certain and claim nothing about
  // how much will be examined.
  if (!ocrMaxPairs) return `This Storyboard has ${pairs} step${plural}.`;
  return pairs > ocrMaxPairs
    ? `Compares the first ${ocrMaxPairs} of ${pairs} steps in this Storyboard.`
    : `Compares all ${pairs} step${plural} in this Storyboard.`;
}

function updateStoryboardCoverage() {
  const select = document.getElementById('reportStoryboardSelect');
  const coverage = document.getElementById('reportStoryboardCoverage');
  const chosen = reportStoryboards.find((s) => s.id === select.value);
  coverage.textContent = chosen ? storyboardCoverageText(chosen) : '';
}

let reportStoryboards = [];

/** Loads the Project's Storyboards into the picker, or explains why it cannot. */
async function loadReportStoryboards() {
  const projectId = document.getElementById('reportProjectSelect').value;
  const select = document.getElementById('reportStoryboardSelect');
  const coverage = document.getElementById('reportStoryboardCoverage');

  reportStoryboards = [];
  select.innerHTML = '';
  coverage.textContent = '';
  if (!projectId) return;

  try {
    const data = await apiFetch(`/admin/projects/${encodeURIComponent(projectId)}/storyboards`);
    reportStoryboards = data.storyboards;
    ocrMaxPairs = data.maxPairs ?? null;
  } catch (err) {
    coverage.textContent = err.message || 'Could not load Storyboards for this project.';
    return;
  }

  if (reportStoryboards.length === 0) {
    coverage.textContent = 'This project has no Storyboards yet. Build one from the Projects tab first.';
    return;
  }

  select.innerHTML = reportStoryboards.map((s) => `
    <option value="${esc(s.id)}">${esc(s.createdAt ? fmtDate(s.createdAt) : s.id)} — ${esc(String(s.includedCaptures))} of ${esc(String(s.totalCaptures))} Captures</option>
  `).join('');
  updateStoryboardCoverage();
}

/** The picker belongs to the OCR type alone; every other report is Project-scoped. */
async function onReportTypeChange() {
  const isOcr = document.getElementById('reportTypeSelect').value === OCR_REPORT_TYPE;
  setHidden(document.getElementById('reportStoryboardGroup'), !isOcr);
  if (isOcr) await loadReportStoryboards();
}

function openGenerateReportModal() {
  document.getElementById('generateReportError').textContent = '';
  document.getElementById('generateReportSubmitBtn').disabled = false;
  openModal('generateReportModal');
  onReportTypeChange();
}

async function submitGenerateReport() {
  const projectId = document.getElementById('reportProjectSelect').value;
  const reportType = document.getElementById('reportTypeSelect').value;
  const errorEl = document.getElementById('generateReportError');
  const btn = document.getElementById('generateReportSubmitBtn');

  if (!projectId) { errorEl.textContent = 'Please select a project.'; return; }

  const isOcr = reportType === OCR_REPORT_TYPE;
  const storyboardId = document.getElementById('reportStoryboardSelect').value;
  if (isOcr && !storyboardId) {
    errorEl.textContent = 'Please select a Storyboard for this report type.';
    return;
  }

  errorEl.textContent = ''; btn.disabled = true; btn.textContent = 'Generating...';
  try {
    const res = await apiFetch('/admin/reports/generate', {
      method: 'POST',
      // Never a dateRange: the backend refuses one (#95). A Report covers all
      // of a Project's Captures, and an OCR Report the Storyboard it names.
      body: JSON.stringify(isOcr ? { projectId, reportType, storyboardId } : { projectId, reportType })
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

  table.style.display = 'table';
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
          <button class="btn btn-ghost" ${r.status !== 'done' ? 'disabled' : ''} onclick="viewReport('${r.id}')">View</button>
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

// ── Report viewer (#120) ───────────────────────────────────────
// The View button has always been enabled the moment a Report reached `done`,
// so the affordance was real and the content was not. The history is in
// backend/src/lib/reportArtifact.js; what matters here is that everything
// rendered below comes from a model's output or a Monitored User's page, and
// the panel is filled with innerHTML — so every interpolated value goes
// through esc(), and portal/tests/report-viewer-contract.test.js fails if one
// stops doing so.

/** The metrics table, in the order the artifact lists them. */
function renderReportMetrics(metrics) {
  const rows = Object.entries(metrics).map(([key, value]) => {
    // null is what reportMetrics.js returns when there was nothing to divide
    // by. Showing "0" here would be a claim about work nobody measured.
    const shown = (value === null || value === undefined) ? 'not measured' : String(value);
    return `<tr><td class="muted" style="padding-right:var(--space-4)">${esc(key)}</td><td>${esc(shown)}</td></tr>`;
  }).join('');
  return `<table style="margin:var(--space-3) 0">${rows}</table>`;
}

/**
 * A field's state, made readable.
 *
 * The model returns `""` for a text field that exists but holds no value —
 * accurate, and it renders as "not present → " with nothing after the arrow.
 * Named here rather than asked for in the prompt, so the wording can change
 * without a live Vertex run to re-verify it.
 */
function fieldState(state) {
  return (state === null || state === undefined || String(state).trim() === '')
    ? '(empty)'
    : String(state);
}

/** What one OCR comparison found between two consecutive Captures (#96). */
function renderComparison(comparison) {
  const heading = `Step ${esc(String(comparison.from.order))} → ${esc(String(comparison.to.order))}`;

  // The Analyst's note sits beside the finding, never inside the prompt that
  // produced it (ADR 0017). Showing both is what lets a reader see whether the
  // note and the finding agree.
  const notes = [comparison.from.note, comparison.to.note].filter(Boolean)
    .map((n) => `<div class="muted">“${esc(n)}”</div>`).join('');

  let body;
  if (comparison.error) {
    body = `<div class="muted">This comparison could not be made: ${esc(comparison.error)}</div>`;
  } else if (comparison.findings.length === 0) {
    // Not omitted: "nothing changed here" is a real observation, and an absent
    // finding must not look like a pair that was never examined.
    body = '<div class="muted">No changes detected.</div>';
  } else {
    body = `<table style="margin-top:var(--space-2)">${comparison.findings.map((f) => `
      <tr>
        <td class="muted" style="padding-right:var(--space-3)">${esc(f.elementType)}</td>
        <td style="padding-right:var(--space-3)">${esc(f.label)}</td>
        <td class="muted">${esc(fieldState(f.oldState))} → ${esc(fieldState(f.newState))}</td>
      </tr>`).join('')}</table>`;
  }

  return `
    <div style="border-left:2px solid var(--color-border);padding-left:var(--space-3);margin:var(--space-3) 0">
      <div style="font-weight:600">${heading}</div>
      ${notes}
      ${body}
      <div class="muted" style="font-size:var(--text-xs);margin-top:var(--space-2)">
        ${esc(comparison.from.captureId)} → ${esc(comparison.to.captureId)}
      </div>
    </div>`;
}

/** An OCR Report: what changed at each step of a Storyboard, and how much was examined. */
function renderOcrArtifact(reportType, artifact) {
  const c = artifact.coverage;
  const notLookedAt = c.availablePairs - c.comparedPairs;

  const coverage = [
    `Compared ${esc(String(c.comparedPairs))} of ${esc(String(c.availablePairs))} steps`,
    notLookedAt > 0 ? `${esc(String(notLookedAt))} later steps were not examined` : null,
    c.droppedCaptures > 0
      ? `${esc(String(c.droppedCaptures))} Capture(s) had no stored image, so no comparison spans them`
      : null,
  ].filter(Boolean).join('. ');

  return `
    <div style="font-weight:600;margin-bottom:var(--space-2)">${esc(reportType)}</div>
    <div class="muted" style="margin-bottom:var(--space-3)">${coverage}.</div>
    ${artifact.comparisons.map(renderComparison).join('')}
    <details style="margin-top:var(--space-4)">
      <summary class="muted">Full artifact</summary>
      <pre style="margin-top:var(--space-2);font-family:var(--font-mono);font-size:var(--text-xs);white-space:pre-wrap;word-break:break-word">${esc(JSON.stringify(artifact, null, 2))}</pre>
    </details>`;
}

/** A standard Report: its narrative, whether that narrative was trusted, its figures. */
function renderReportArtifact(reportType, artifact) {
  // An OCR Report is a different shape: comparisons, not metrics and a summary.
  if (Array.isArray(artifact.comparisons)) return renderOcrArtifact(reportType, artifact);

  const parts = [`<div style="font-weight:600;margin-bottom:var(--space-3)">${esc(reportType)}</div>`];

  if (artifact.summary) {
    // No font-family here: styles.css defines --font-mono and no --font-sans,
    // so naming one would resolve to nothing and inherit whatever the panel has.
    parts.push(`<p style="line-height:1.5">${esc(artifact.summary)}</p>`);
  }

  // #119 replaces a narrative that claimed more than the metrics support, and
  // keeps the rejected text on the artifact so the substitution is visible
  // rather than a summary that quietly went missing. Surfacing it is the whole
  // point of writing it.
  const guard = artifact.summaryGuard;
  if (guard && guard.status === 'rejected') {
    parts.push(`
      <div style="border-left:3px solid var(--color-warning, #b45309);padding-left:var(--space-3);margin:var(--space-3) 0">
        <div style="font-weight:600">The generated narrative was not published.</div>
        <div class="muted">It contained claims the measurements do not support: ${esc((guard.markers || []).join(', '))}.</div>
        <details style="margin-top:var(--space-2)">
          <summary>What the model wrote</summary>
          <div style="margin-top:var(--space-2)">${esc(guard.rejectedSummary || '')}</div>
        </details>
      </div>`);
  }

  if (artifact.llmError) {
    parts.push(`<div class="muted">The narrative could not be generated: ${esc(artifact.llmError)}</div>`);
  }

  if (artifact.metrics) parts.push(renderReportMetrics(artifact.metrics));

  parts.push(`
    <details style="margin-top:var(--space-4)">
      <summary class="muted">Full artifact</summary>
      <pre style="margin-top:var(--space-2);font-family:var(--font-mono);font-size:var(--text-xs);white-space:pre-wrap;word-break:break-word">${esc(JSON.stringify(artifact, null, 2))}</pre>
    </details>`);

  return parts.join('');
}

/** A PDF or video artifact: a short-lived signed link, not bytes through the API. */
function renderReportDownload(reportType, contentType, url) {
  return `
    <div style="font-weight:600;margin-bottom:var(--space-3)">${esc(reportType)}</div>
    <p style="line-height:1.5">
      This report is a ${esc(contentType)} file.
      <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open it</a>.
      The link expires in a few minutes.
    </p>`;
}

async function viewReport(reportId) {
  const panel = document.getElementById('reportViewerContent');
  panel.textContent = 'Loading report…';
  openModal('reportViewerModal');

  try {
    const data = await apiFetch(`/admin/reports/${encodeURIComponent(reportId)}/artifact`);
    panel.innerHTML = data.artifact
      ? renderReportArtifact(data.reportType, data.artifact)
      : renderReportDownload(data.reportType, data.contentType, data.url);
  } catch (err) {
    // A Report that is queued, errored, or whose object has gone says which —
    // an empty panel is the thing this replaced.
    panel.textContent = err.message || 'This report could not be loaded.';
  }
}

// ── Boot ───────────────────────────────────────────────────────
// Auth guard runs first; on success it reveals the app layout
// and then we boot the default data load (dashboard).
runAuthGuard().then(() => {
  if (document.getElementById('appLayout').classList.contains('ready')) {
    loadDashboard();
  }
});
