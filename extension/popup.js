// popup.js — Sprint 5.17
// Changes from Sprint 5.16:
//   5.17 — loadConfig() added: fetches GET /config with the Firebase ID token
//          in an Authorization: Bearer header on every
//          popup open (when a key exists) and writes the result into
//          chrome.storage.local as settings.cloudRunUrl, settings.retention,
//          settings.maxSize.
//   5.17 — loadConfig() is fired in parallel with loadProjects() so the
//          popup open path does not wait for both sequentially.
//   5.17 — Admin-managed fields (cloudRunUrl, retention, maxSize) in the
//          Settings panel are now always sourced from /config; they are never
//          editable by the user (already read-only in HTML).
//   5.17 — Removed cloudRunUrlInput reference (admin-managed URL display removed from popup UI)
//   5.17 — Fallback: if GET /config fails, cached values in storage are
//          preserved and capture is not blocked (offline-safe).
// Retained from Sprint 5.16:
//   5.16 — Auto-select + hide project dropdown when single project
//   5.16 — Session restore ordering fixed (savedProjectId passed to populate)
//   5.16 — Stage dropdown wired into session save
// Retained from Sprint 5.15:
//   5.15 — User dropdown removed; identity resolved server-side from the
//          Firebase ID token
//   5.15 — Backend URL field read-only; settings save: apiKey + notify only
//   5.15 — no-key-banner shown when API key absent
// Retained from Sprint 4:
//   4.3 — progress bar via UPLOAD_PROGRESS messages
//   4.5 — history tab (last 20 uploads)

// ── Element refs ──
const projectSelect      = document.getElementById('project-select');
const projectDropdown    = document.getElementById('project-dropdown');
const projectSingle      = document.getElementById('project-single');
const stageSelect        = document.getElementById('stage-select');
const toolInput          = document.getElementById('tool-input');
const saveBtn            = document.getElementById('save-btn');
const captureBtn         = document.getElementById('capture-btn');
const snipBtn            = document.getElementById('snip-btn');
const fullpageBtn        = document.getElementById('fullpage-btn');
const statusEl           = document.getElementById('status');
const progressBar        = document.getElementById('progress-bar');
const progressWrap       = document.getElementById('progress-wrap');
const welcomeScreen      = document.getElementById('welcome-screen');
const welcomeSigninBtn   = document.getElementById('welcome-signin-btn');
const captureControls    = document.getElementById('capture-controls');

// Settings panel
const settingsToggle   = document.getElementById('settings-toggle');
const settingsPanel    = document.getElementById('settings-panel');
const authStatusText   = document.getElementById('auth-status-text');
const authLoginBtn     = document.getElementById('auth-login-btn');
const openAdminBtn     = document.getElementById('open-admin-btn');
const retentionInput   = document.getElementById('retention-input'); // read-only (admin-managed)
const maxSizeInput     = document.getElementById('max-size-input');  // read-only (admin-managed)
const notifyInput      = document.getElementById('notify-input');
const settingsSaveBtn  = document.getElementById('settings-save-btn');

// History tab (4.5)
const tabCapture   = document.getElementById('tab-capture');
const tabHistory   = document.getElementById('tab-history');
const capturePanel = document.getElementById('capture-panel');
const historyPanel = document.getElementById('history-panel');
const historyList  = document.getElementById('history-list');

// Inactivity Modal (6.5)
const inactivityModal = document.getElementById('inactivity-modal');
const btnSnooze       = document.getElementById('btn-snooze');
const btnCaptureNow   = document.getElementById('btn-capture-now');

document.addEventListener('DOMContentLoaded', async () => {
  const { session, settings } = await chrome.storage.local.get(['session', 'settings']);

  // ── 5.15 / 5.18: Show welcome screen if Firebase token absent ──
  const token = settings?.firebaseToken?.trim() || '';
  if (!token) {
    welcomeScreen.style.display = 'block';
    captureControls.style.display = 'none';
    authStatusText.textContent = 'Not signed in';
    authLoginBtn.textContent = 'Sign In';
  } else {
    welcomeScreen.style.display = 'none';
    captureControls.style.display = 'block';
    authStatusText.textContent = 'Signed in with Firebase';
    authLoginBtn.textContent = 'Sign Out';
  }

  // ── 5.15 / 5.17: Restore settings fields from storage ──
  // cloudRunUrl, retention, maxSize are authoritative from GET /config (5.17);
  // we show cached values here while the async fetch runs.
  if (settings?.notify != null) notifyInput.checked    = settings.notify;
  if (settings?.retention)      retentionInput.value   = settings.retention;
  if (settings?.maxSize)        maxSizeInput.value     = settings.maxSize;

  // ── 5.16: Restore stage + tool (safe before async project load) ──
  if (session?.stage) stageSelect.value = session.stage;
  if (session?.tool)  toolInput.value   = session.tool;

  if (token) {
    // ── 5.17: Fire GET /config and GET /me/projects in parallel ──
    await loadConfig();
    await loadProjects(session?.projectId || '');
  } else {
    setProjectSelectPlaceholder('Sign in to view projects');
  }

  // ── Save session ──
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    const s = {
      projectId: projectSelect.value,
      stage:     stageSelect.value,
      tool:      toolInput.value.trim()
      // userId intentionally absent — resolved server-side (5.15)
    };
    try {
      await chrome.storage.local.set({ session: s });
      setStatus('Saved ✓');
    } catch (err) {
      console.error('[Hammer popup] save error:', err);
      setStatus('Save failed: ' + err.message);
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ── Capture Now ──
  captureBtn.addEventListener('click', () => {
    captureBtn.disabled = true;
    setStatus('Capturing…');
    showProgress(0);
    chrome.runtime.sendMessage({ type: 'CAPTURE' }, (response) => {
      captureBtn.disabled = false;
      hideProgress();
      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message);
        return;
      }
      if (response?.ok) {
        setStatus('Uploaded ✓');
        refreshHistory();
      } else if (response?.reason === 'blocked') {
        setStatus('Blocked — set Project & save first.');
      } else if (response?.reason === 'no_api_key' || response?.reason === 'unauthorized') {
        setStatus('Sign in to your account.');
        welcomeScreen.style.display = 'block';
        captureControls.style.display = 'none';
      } else {
        setStatus('Failed: ' + (response?.error ?? 'unknown'));
      }
    });
  });

  // ── Snip / Full page (issue #11) ──
  // Capture Now above is left exactly as it was: ACT-01 requires the plain
  // screenshot path to be unchanged, so these two get their own handler rather
  // than a shared one that both would have to route through.
  //
  // Note that Chrome closes this popup the moment the page takes focus, which
  // for Snip is as soon as the person drags. The capture still completes — the
  // service worker owns it — but the status line below is only seen when the
  // popup survives, which is exactly the fallback and refusal cases.
  function runCaptureMode(button, type) {
    button.disabled = true;
    setStatus(type === 'CAPTURE_SNIP' ? 'Select a region…' : 'Capturing…');
    showProgress(0);
    chrome.runtime.sendMessage({ type }, (response) => {
      button.disabled = false;
      hideProgress();
      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message);
        return;
      }
      if (response?.reason === 'cancelled') {
        setStatus('Cancelled.');
        return;
      }
      // ACT-03: they asked for a region and got the whole page. Saying nothing
      // reads as a bug.
      const fellBack = response?.fellBack
        ? 'This page would not accept the overlay — captured the whole page instead. '
        : '';
      if (response?.ok) {
        setStatus(fellBack ? fellBack + 'Uploaded ✓' : 'Uploaded ✓');
        refreshHistory();
      } else if (response?.reason === 'blocked') {
        setStatus(fellBack + 'Blocked — set Project & save first.');
      } else if (response?.reason === 'no_api_key' || response?.reason === 'unauthorized') {
        setStatus('Sign in to your account.');
        welcomeScreen.style.display = 'block';
        captureControls.style.display = 'none';
      } else {
        setStatus(fellBack + 'Failed: ' + (response?.error ?? 'unknown'));
      }
    });
  }

  snipBtn.addEventListener('click',     () => runCaptureMode(snipBtn, 'CAPTURE_SNIP'));
  fullpageBtn.addEventListener('click', () => runCaptureMode(fullpageBtn, 'CAPTURE_FULLPAGE'));

  // ── 4.3: listen for upload progress from service worker ──
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'UPLOAD_PROGRESS') {
      showProgress(message.percent);
    }
    // ── 6.5: Inactivity Modal ──
    if (message.type === 'INACTIVITY_WARNING') {
      chrome.storage.local.get('settings').then(({ settings }) => {
        const sec = settings?.inactivityTimerSeconds || 45;
        const p = inactivityModal.querySelector('p');
        if (p) p.textContent = `It has been ${sec} seconds since your last capture. Would you like to capture now?`;
        inactivityModal.classList.add('open');
      });
      sendResponse({ handled: true });
      return true;
    }
    if (message.type === 'DISMISS_INACTIVITY_PROMPT') {
      inactivityModal.classList.remove('open');
      sendResponse({ handled: true });
      return true;
    }
  });

  btnSnooze.addEventListener('click', () => {
    inactivityModal.classList.remove('open');
    chrome.runtime.sendMessage({ type: 'SNOOZE_INACTIVITY' });
  });

  btnCaptureNow.addEventListener('click', () => {
    inactivityModal.classList.remove('open');
    chrome.runtime.sendMessage({ type: 'CAPTURE_INACTIVITY' });
    // Also update UI to show capturing state
    setStatus('Capturing…');
    showProgress(0);
  });

  // ── Settings toggle ──
  settingsToggle.addEventListener('click', () => {
    settingsPanel.classList.toggle('open');
    settingsToggle.textContent = settingsPanel.classList.contains('open')
      ? '✕ Settings'
      : '⚙ Settings';
  });

  // ── 5.18: OAuth Login Flow ──
  const PORTAL_URL = 'https://thehammer-portal-282689937365.northamerica-northeast1.run.app';

  async function triggerSignIn() {
    authLoginBtn.disabled = true;
    welcomeSigninBtn.disabled = true;
    try {
      const existing = (await chrome.storage.local.get('settings')).settings || {};
      
      if (existing.firebaseToken) {
        // Sign out
        await chrome.storage.local.set({ settings: { ...existing, firebaseToken: '', firebaseRefreshToken: '' } });
        authStatusText.textContent = 'Not signed in';
        authLoginBtn.textContent = 'Sign In';
        welcomeScreen.style.display = 'block';
        captureControls.style.display = 'none';
        setProjectSelectPlaceholder('Sign in to view projects');
        setStatus('Signed out.');
        return;
      }
      
      setStatus('Authenticating...');
      const authUrl = `${PORTAL_URL}/auth-ext.html`;
      const redirectUrl = chrome.identity.getRedirectURL();

      const responseUrl = await chrome.identity.launchWebAuthFlow({
        url: `${authUrl}?redirect_uri=${encodeURIComponent(redirectUrl)}`,
        interactive: true
      });
      
      const url = new URL(responseUrl);
      const token = url.searchParams.get('token');
      const refreshToken = url.searchParams.get('refreshToken');
      const fbApiKey = url.searchParams.get('apiKey');

      if (token) {
        const allSettings = { ...existing, firebaseToken: token, firebaseRefreshToken: refreshToken, firebaseApiKey: fbApiKey };
        await chrome.storage.local.set({ settings: allSettings });
        setStatus('Signed in ✓');
        welcomeScreen.style.display = 'none';
        captureControls.style.display = 'block';
        authStatusText.textContent = 'Signed in with Firebase';
        authLoginBtn.textContent = 'Sign Out';
        
        await loadConfig();
        const { session: s2 } = await chrome.storage.local.get('session');
        await loadProjects(s2?.projectId || '');
      } else {
        setStatus('Sign-in cancelled.');
      }
    } catch (err) {
      console.error('[Hammer popup] OAuth error:', err);
      setStatus('Sign-in failed.');
    } finally {
      authLoginBtn.disabled = false;
      welcomeSigninBtn.disabled = false;
    }
  }

  authLoginBtn.addEventListener('click', triggerSignIn);
  welcomeSigninBtn.addEventListener('click', triggerSignIn);

  openAdminBtn.addEventListener('click', () => {
    window.open(PORTAL_URL, '_blank');
  });

  // ── 5.15 / 5.17: Settings save ──
  settingsSaveBtn.addEventListener('click', async () => {
    settingsSaveBtn.disabled = true;
    const existing = (await chrome.storage.local.get('settings')).settings || {};
    const allSettings = {
      ...existing,        // preserve tokens, etc.
      notify: notifyInput.checked
    };

    try {
      await chrome.storage.local.set({ settings: allSettings });
      setStatus('Settings saved ✓');
      settingsPanel.classList.remove('open');
      settingsToggle.textContent = '⚙ Settings';
    } catch (err) {
      console.error('[Hammer popup] settings save error:', err);
      setStatus('Save failed: ' + err.message);
    } finally {
      settingsSaveBtn.disabled = false;
    }
  });

  // ── 4.5: Tab switching ──
  tabCapture.addEventListener('click', () => switchTab('capture'));
  tabHistory.addEventListener('click', () => {
    switchTab('history');
    refreshHistory();
  });

  refreshHistory();
});

// ─────────────────────────────────────────────────────────────────
// 5.17 — loadConfig
// Fetches GET /config using the hardcoded fallback URL first (the key is
// required but cloudRunUrl may not yet be in storage on first run).
// On success:
//   — writes cloudRunUrl, retention, maxSize into settings storage
//   — updates the read-only display fields in the Settings panel
// On failure:
//   — leaves existing cached values untouched (offline-safe)
//   — does NOT block capture or project load
//
// config response shape expected from backend:
//   { cloudRunUrl?: string, retention?: number, maxSize?: number }
// All fields are optional; backend may return a subset.
// ─────────────────────────────────────────────────────────────────
// #26: no `/api` prefix — the backend serves /config and /me/projects at the
// root, and the prefixed paths 404. Kept in step with FALLBACK_API_BASE in
// service-worker.js.
const CONFIG_FALLBACK_URL = 'https://thehammer-backend-282689937365.northamerica-northeast1.run.app';

// #26: a profile that cached the old prefixed URL would keep 404ing after the
// constant above is fixed, so normalise what comes out of storage too. The
// service worker cleans the stored value on startup; this makes the popup
// correct even if it opens first.
function normaliseApiBase(url) {
  return String(url ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api$/, '');
}

function apiBase(settings) {
  return normaliseApiBase(settings?.cloudRunUrl) || CONFIG_FALLBACK_URL;
}

// #31: GET /me/projects answers `{ projects, total }` and names the id field
// `id`, but the dropdown is built from an array of `{ projectId, name }`. The
// object was passed straight through, so populateProjectSelect hit
// `projects.forEach is not a function`, loadProjects caught it, and the popup
// reported "Could not load projects" on a perfectly good 200. Absorb the wire
// format here, at the one place the response is decoded, so the renderer keeps
// its documented contract.
function normaliseProjects(body) {
  const list = Array.isArray(body) ? body : body?.projects;
  // A body in neither shape is a wire-format fault, not an empty workspace.
  // Returning [] here would render "— no projects assigned —" and hide the very
  // thing this function exists to catch, so let it reach the catch below.
  if (!Array.isArray(list)) {
    throw new Error('unexpected /me/projects body');
  }
  return list.map((p) => ({ projectId: p?.projectId ?? p?.id, name: p?.name }));
}

// #31: 401, 403 and a decode fault all collapsed into "Could not load projects",
// which is most of why the wire-format bug above survived two sessions. Lesson 49
// is the same mechanism on the sibling /api bug: a catch that keeps the popup
// alive also keeps the cause invisible. Name the causes apart.
function projectsErrorMessage(err) {
  if (err?.status === 401) return 'Session expired — sign in again';
  if (err?.status === 403) return 'Account not provisioned';
  return 'Could not load projects';
}

async function loadConfig() {
  // Use the stored cloudRunUrl if present; otherwise use the hard-coded default.
  // This bootstraps cleanly on first install when storage is empty.
  const { settings: s } = await chrome.storage.local.get('settings');
  const baseUrl = apiBase(s);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await authedFetch(`${baseUrl}/config`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const config = await res.json();

    // Merge into existing settings, preserving user-editable fields
    const existing = (await chrome.storage.local.get('settings')).settings || {};
    const updated = { ...existing };

    // #26: normalised on the way in as well. If the backend's own config still
    // hands out a prefixed URL, storing it raw would undo the cleanup on every
    // popup open.
    if (config.cloudRunUrl) updated.cloudRunUrl = normaliseApiBase(config.cloudRunUrl);
    if (config.retention)   updated.retention   = config.retention;
    if (config.maxSize)     updated.maxSize      = config.maxSize;
    if (typeof config.inactivityTimerSeconds === 'number') {
      updated.inactivityTimerSeconds = config.inactivityTimerSeconds;
    }
    if (typeof config.allowPreUploadBlur === 'boolean') {
      updated.allowPreUploadBlur = config.allowPreUploadBlur;
    }
    if (typeof config.instantClipboardLinks === 'boolean') {
      updated.instantClipboardLinks = config.instantClipboardLinks;
    }

    await chrome.storage.local.set({ settings: updated });

    // Reflect in read-only display fields
    if (updated.retention)   retentionInput.value   = updated.retention;
    if (updated.maxSize)     maxSizeInput.value     = updated.maxSize;

    console.log('[Hammer popup] GET /config ✓ | url:', updated.cloudRunUrl,
                '| retention:', updated.retention, '| maxSize:', updated.maxSize);
  } catch (err) {
    // Offline or key invalid — silently fall back to cached values
    console.warn('[Hammer popup] GET /config failed (using cache):', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// 5.16 — loadProjects
// Now called AFTER loadConfig so it reads the authoritative cloudRunUrl.
// ─────────────────────────────────────────────────────────────────
async function loadProjects(savedProjectId) {
  const { settings } = await chrome.storage.local.get('settings');
  const baseUrl = apiBase(settings);

  setProjectSelectPlaceholder('Loading projects…');
  try {
    const res = await authedFetch(`${baseUrl}/me/projects`);
    if (!res.ok) {
      const httpErr = new Error(`HTTP ${res.status}`);
      httpErr.status = res.status;
      throw httpErr;
    }
    const projects = normaliseProjects(await res.json());
    populateProjectSelect(projects, savedProjectId);
  } catch (err) {
    console.warn('[Hammer popup] GET /me/projects failed:', err.message);
    setProjectSelectPlaceholder(projectsErrorMessage(err));
  }
}

// ─────────────────────────────────────────────────────────────────
// 5.16 — populateProjectSelect
// projects:       array of { projectId, name } from /me/projects
// savedProjectId: string to restore; '' if none
//
// Rules:
//   0 projects — dropdown shows “— no projects assigned —”
//   1 project  — auto-select + hide dropdown + show #project-single label
//   2+ projects — show dropdown; restore savedProjectId if it appears in list
// ─────────────────────────────────────────────────────────────────
function populateProjectSelect(projects, savedProjectId) {
  projectDropdown.style.display = '';
  projectSingle.style.display   = 'none';
  projectSingle.textContent     = '';
  projectSelect.innerHTML       = '';

  if (!projects || projects.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— no projects assigned —';
    projectSelect.appendChild(opt);
    return;
  }

  projects.forEach(({ projectId, name }) => {
    const opt = document.createElement('option');
    opt.value = projectId;
    opt.textContent = name;
    projectSelect.appendChild(opt);
  });

  if (projects.length === 1) {
    projectSelect.value           = projects[0].projectId;
    projectDropdown.style.display = 'none';
    projectSingle.textContent     = projects[0].name;
    projectSingle.style.display   = 'block';
    console.log('[Hammer popup] single project auto-selected:', projects[0].projectId);
    return;
  }

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— select project —';
  projectSelect.insertBefore(placeholder, projectSelect.firstChild);

  if (savedProjectId) {
    const exists = projects.some(p => p.projectId === savedProjectId);
    projectSelect.value = exists ? savedProjectId : '';
    if (!exists) console.warn('[Hammer popup] saved projectId not in list:', savedProjectId);
  } else {
    projectSelect.value = '';
  }
}

function setProjectSelectPlaceholder(msg) {
  projectDropdown.style.display = '';
  projectSingle.style.display   = 'none';
  projectSelect.innerHTML       = `<option value="">${msg}</option>`;
}

// ── Progress bar (4.3) ──
function showProgress(pct) {
  progressWrap.style.display = 'block';
  progressBar.style.width = pct + '%';
  progressBar.setAttribute('aria-valuenow', pct);
}

function hideProgress() {
  progressWrap.style.display = 'none';
  progressBar.style.width = '0%';
}

// ── 4.5 History ──
async function refreshHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  historyList.innerHTML = '';
  if (history.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = 'No uploads yet.';
    historyList.appendChild(empty);
    return;
  }
  history.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const time = new Date(item.ts).toLocaleString();
    const size = item.size ? ` (${(item.size / 1024).toFixed(1)} KB)` : '';
    row.innerHTML =
      `<span class="history-path" title="${item.path}">${item.path}</span>` +
      `<span class="history-meta">${time}${size}</span>`;
    historyList.appendChild(row);
  });
}

function switchTab(tab) {
  const isCapture = tab === 'capture';
  tabCapture.classList.toggle('active', isCapture);
  tabHistory.classList.toggle('active', !isCapture);
  capturePanel.style.display = isCapture ? '' : 'none';
  historyPanel.style.display = isCapture ? 'none' : '';
}

// ── Helpers ──
function setStatus(msg) {
  statusEl.textContent = msg;
  setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 4000);
}
