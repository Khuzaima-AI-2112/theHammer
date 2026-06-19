// popup.js — Sprint 5.15
// Changes from Sprint 4:
//   5.15 — User dropdown removed; identity resolved server-side via Personal API Key
//   5.15 — SEED_CONFIG and userSelect logic removed
//   5.15 — Backend URL field is read-only (defaults to https://app.thehammer.io/api)
//   5.15 — Settings panel saves only: apiKey + notify (user-controlled prefs)
//   5.15 — no-key-banner shown when API key is absent
//   5.16 (scaffold) — project-select and stage-select present; project list
//          populated from GET /me/projects on load (wired up fully in 5.16)
// Retained from Sprint 4:
//   4.3 — progress bar via UPLOAD_PROGRESS messages
//   4.5 — history tab (last 20 uploads)

// ── Element refs ──
const projectSelect   = document.getElementById('project-select');
const stageSelect     = document.getElementById('stage-select');
const toolInput       = document.getElementById('tool-input');
const saveBtn         = document.getElementById('save-btn');
const captureBtn      = document.getElementById('capture-btn');
const statusEl        = document.getElementById('status');
const progressBar     = document.getElementById('progress-bar');
const progressWrap    = document.getElementById('progress-wrap');
const noKeyBanner     = document.getElementById('no-key-banner');
const openSettingsBanner = document.getElementById('open-settings-banner');

// Settings panel
const settingsToggle  = document.getElementById('settings-toggle');
const settingsPanel   = document.getElementById('settings-panel');
const cloudRunUrlInput = document.getElementById('cloud-run-url');  // read-only
const apiKeyInput     = document.getElementById('api-key-input');
const retentionInput  = document.getElementById('retention-input'); // read-only (admin-managed)
const maxSizeInput    = document.getElementById('max-size-input');  // read-only (admin-managed)
const notifyInput     = document.getElementById('notify-input');
const settingsSaveBtn = document.getElementById('settings-save-btn');

// History tab (4.5)
const tabCapture   = document.getElementById('tab-capture');
const tabHistory   = document.getElementById('tab-history');
const capturePanel = document.getElementById('capture-panel');
const historyPanel = document.getElementById('history-panel');
const historyList  = document.getElementById('history-list');

document.addEventListener('DOMContentLoaded', async () => {
  const { session, settings } = await chrome.storage.local.get(['session', 'settings']);

  // ── 5.15: Show no-key-banner if API key has never been set ──
  const apiKey = settings?.apiKey?.trim() || '';
  if (!apiKey) {
    noKeyBanner.style.display = 'block';
    captureBtn.disabled = true;
  }

  // ── 5.15: Restore settings fields ──
  // Backend URL is always the read-only default; never overwritten from storage
  // (task 5.17 will overwrite it from GET /config, but it remains read-only to the user)
  if (settings?.apiKey)    apiKeyInput.value      = settings.apiKey;
  if (settings?.notify != null) notifyInput.checked = settings.notify;
  // Admin-managed read-only fields — populated from GET /config in task 5.17
  if (settings?.retention) retentionInput.value   = settings.retention;
  if (settings?.maxSize)   maxSizeInput.value     = settings.maxSize;

  // ── Restore session (project, stage, tool) ──
  if (session?.projectId) projectSelect.value = session.projectId;
  if (session?.stage)     stageSelect.value   = session.stage;
  if (session?.tool)      toolInput.value     = session.tool;

  // ── 5.16 scaffold: populate project dropdown from GET /me/projects ──
  // Full wiring happens in task 5.16; for now we attempt the call and fall
  // back gracefully if the key is missing or the call fails.
  if (apiKey) {
    await loadProjects(apiKey);
  } else {
    setProjectSelectPlaceholder('Paste API key in Settings first');
  }

  // ── Save session ──
  saveBtn.addEventListener('click', async () => {
    const s = {
      projectId: projectSelect.value,
      stage:     stageSelect.value,
      tool:      toolInput.value.trim()
      // userId intentionally absent — resolved server-side from X-Api-Key (5.15)
    };
    try {
      await chrome.storage.local.set({ session: s });
      setStatus('Saved ✓');
    } catch (err) {
      console.error('[Hammer popup] save error:', err);
      setStatus('Save failed: ' + err.message);
    }
  });

  // ── Capture Now ──
  captureBtn.addEventListener('click', () => {
    setStatus('Capturing…');
    showProgress(0);
    chrome.runtime.sendMessage({ type: 'CAPTURE' }, (response) => {
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
      } else if (response?.reason === 'no_api_key') {
        setStatus('Paste your Personal API Key in Settings.');
        noKeyBanner.style.display = 'block';
      } else {
        setStatus('Failed: ' + (response?.error ?? 'unknown'));
      }
    });
  });

  // ── 4.3: listen for upload progress from service worker ──
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'UPLOAD_PROGRESS') {
      showProgress(message.percent);
    }
  });

  // ── Settings toggle ──
  settingsToggle.addEventListener('click', () => {
    settingsPanel.classList.toggle('open');
    settingsToggle.textContent = settingsPanel.classList.contains('open')
      ? '✕ Settings'
      : '⚙ Settings';
  });

  // Banner "Open Settings" shortcut
  openSettingsBanner.addEventListener('click', () => {
    settingsPanel.classList.add('open');
    settingsToggle.textContent = '✕ Settings';
    apiKeyInput.focus();
  });

  // ── 5.15: Settings save — only apiKey + notify are user-controlled ──
  // Backend URL, retention, and maxSize are admin-managed (read-only fields).
  settingsSaveBtn.addEventListener('click', async () => {
    const newKey = apiKeyInput.value.trim();
    if (!newKey) {
      setStatus('API key cannot be empty.');
      apiKeyInput.focus();
      return;
    }

    // Preserve existing admin-managed values so they survive the write
    const existing = (await chrome.storage.local.get('settings')).settings || {};
    const allSettings = {
      ...existing,
      apiKey: newKey,
      notify: notifyInput.checked
      // cloudRunUrl: not written here — stays as default or set by GET /config (5.17)
      // retention + maxSize: not written here — populated by GET /config (5.17)
    };

    try {
      await chrome.storage.local.set({ settings: allSettings });
      setStatus('Key saved ✓');
      noKeyBanner.style.display = 'none';
      captureBtn.disabled = false;
      // Re-load projects now that we have a key
      await loadProjects(newKey);
    } catch (err) {
      console.error('[Hammer popup] settings save error:', err);
      setStatus('Save failed: ' + err.message);
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
// 5.16 scaffold — load project list from GET /me/projects
// Full implementation (auto-select if 1 project, hide dropdown) in task 5.16.
// Fails gracefully: on error, dropdown shows a "could not load" message.
// ─────────────────────────────────────────────────────────────────
async function loadProjects(apiKey) {
  const { settings } = await chrome.storage.local.get('settings');
  // Read the stored cloudRunUrl if present; fall back to the default.
  const baseUrl = settings?.cloudRunUrl?.trim() || 'https://app.thehammer.io/api';

  setProjectSelectPlaceholder('Loading projects…');
  try {
    const res = await fetch(`${baseUrl}/me/projects`, {
      headers: { 'X-Api-Key': apiKey }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const projects = await res.json();
    populateProjectSelect(projects);
  } catch (err) {
    console.warn('[Hammer popup] GET /me/projects failed:', err.message);
    setProjectSelectPlaceholder('Could not load projects');
  }
}

function populateProjectSelect(projects) {
  projectSelect.innerHTML = '';
  if (!projects || projects.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— no projects assigned —';
    projectSelect.appendChild(opt);
    return;
  }
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = projects.length === 1 ? projects[0].name : '— select project —';
  projectSelect.appendChild(placeholder);
  projects.forEach(({ projectId, name }) => {
    const opt = document.createElement('option');
    opt.value = projectId;
    opt.textContent = name;
    projectSelect.appendChild(opt);
  });
  // 5.16: auto-select if only one project
  if (projects.length === 1) {
    projectSelect.value = projects[0].projectId;
  }
}

function setProjectSelectPlaceholder(msg) {
  projectSelect.innerHTML = `<option value="">${msg}</option>`;
}

// ── Progress bar ──
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
