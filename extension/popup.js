// popup.js — Sprint 5.16
// Changes from Sprint 5.15:
//   5.16 — loadProjects now accepts the saved projectId and passes it to
//          populateProjectSelect so the session is restored AFTER the options
//          exist (previously the restore ran before options were populated).
//   5.16 — populateProjectSelect: when exactly 1 project is returned, hide
//          #project-dropdown and show #project-single (read-only label) instead.
//   5.16 — Stage dropdown (Beginning / During / After) wired into session save;
//          already present in HTML from 5.15 scaffold.
//   5.16 — stageSelect restore still runs before loadProjects (it has options
//          baked into HTML so no ordering issue).
// Retained from Sprint 5.15:
//   5.15 — User dropdown removed; identity resolved server-side via Personal API Key
//   5.15 — Backend URL field is read-only (defaults to https://app.thehammer.io/api)
//   5.15 — Settings panel saves only: apiKey + notify (user-controlled prefs)
//   5.15 — no-key-banner shown when API key is absent
// Retained from Sprint 4:
//   4.3 — progress bar via UPLOAD_PROGRESS messages
//   4.5 — history tab (last 20 uploads)

// ── Element refs ──
const projectSelect     = document.getElementById('project-select');
const projectDropdown   = document.getElementById('project-dropdown');
const projectSingle     = document.getElementById('project-single');
const stageSelect       = document.getElementById('stage-select');
const toolInput         = document.getElementById('tool-input');
const saveBtn           = document.getElementById('save-btn');
const captureBtn        = document.getElementById('capture-btn');
const statusEl          = document.getElementById('status');
const progressBar       = document.getElementById('progress-bar');
const progressWrap      = document.getElementById('progress-wrap');
const noKeyBanner       = document.getElementById('no-key-banner');
const openSettingsBanner = document.getElementById('open-settings-banner');

// Settings panel
const settingsToggle   = document.getElementById('settings-toggle');
const settingsPanel    = document.getElementById('settings-panel');
const cloudRunUrlInput = document.getElementById('cloud-run-url');  // read-only
const apiKeyInput      = document.getElementById('api-key-input');
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

document.addEventListener('DOMContentLoaded', async () => {
  const { session, settings } = await chrome.storage.local.get(['session', 'settings']);

  // ── 5.15: Show no-key-banner if API key has never been set ──
  const apiKey = settings?.apiKey?.trim() || '';
  if (!apiKey) {
    noKeyBanner.style.display = 'block';
    captureBtn.disabled = true;
  }

  // ── 5.15: Restore settings fields ──
  if (settings?.apiKey)         apiKeyInput.value  = settings.apiKey;
  if (settings?.notify != null) notifyInput.checked = settings.notify;
  if (settings?.retention)      retentionInput.value = settings.retention;
  if (settings?.maxSize)        maxSizeInput.value   = settings.maxSize;

  // ── 5.16: Restore stage + tool before async project load ──
  // Stage options are baked into HTML, so restore is safe here.
  if (session?.stage) stageSelect.value = session.stage;
  if (session?.tool)  toolInput.value   = session.tool;

  // ── 5.16: Load project list from GET /me/projects ──
  // Pass the saved projectId so populateProjectSelect can restore the
  // selection AFTER the <option> elements exist.
  if (apiKey) {
    await loadProjects(apiKey, session?.projectId || '');
  } else {
    setProjectSelectPlaceholder('Paste API key in Settings first');
  }

  // ── Save session ──
  saveBtn.addEventListener('click', async () => {
    // 5.16: when dropdown is hidden (single project), read the stored value
    // from the hidden <select> which was set by populateProjectSelect.
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

  // Banner “Open Settings” shortcut
  openSettingsBanner.addEventListener('click', () => {
    settingsPanel.classList.add('open');
    settingsToggle.textContent = '✕ Settings';
    apiKeyInput.focus();
  });

  // ── 5.15: Settings save ──
  settingsSaveBtn.addEventListener('click', async () => {
    const newKey = apiKeyInput.value.trim();
    if (!newKey) {
      setStatus('API key cannot be empty.');
      apiKeyInput.focus();
      return;
    }

    const existing = (await chrome.storage.local.get('settings')).settings || {};
    const allSettings = {
      ...existing,
      apiKey: newKey,
      notify: notifyInput.checked
    };

    try {
      await chrome.storage.local.set({ settings: allSettings });
      setStatus('Key saved ✓');
      noKeyBanner.style.display = 'none';
      captureBtn.disabled = false;
      // 5.16: Re-load projects with the new key.
      // Preserve current projectId so selection survives a key update.
      const { session: s2 } = await chrome.storage.local.get('session');
      await loadProjects(newKey, s2?.projectId || '');
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
// 5.16 — loadProjects
// Fetches GET /me/projects and passes results to populateProjectSelect.
// savedProjectId: the projectId from chrome.storage.local session; may be ''.
// ─────────────────────────────────────────────────────────────────
async function loadProjects(apiKey, savedProjectId) {
  const { settings } = await chrome.storage.local.get('settings');
  const baseUrl = settings?.cloudRunUrl?.trim() || 'https://app.thehammer.io/api';

  setProjectSelectPlaceholder('Loading projects…');
  try {
    const res = await fetch(`${baseUrl}/me/projects`, {
      headers: { 'X-Api-Key': apiKey }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const projects = await res.json();
    populateProjectSelect(projects, savedProjectId);
  } catch (err) {
    console.warn('[Hammer popup] GET /me/projects failed:', err.message);
    setProjectSelectPlaceholder('Could not load projects');
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
  // Reset both display modes to a known state first
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

  // Populate hidden <select> in all cases (used by saveBtn to read .value)
  projects.forEach(({ projectId, name }) => {
    const opt = document.createElement('option');
    opt.value = projectId;
    opt.textContent = name;
    projectSelect.appendChild(opt);
  });

  if (projects.length === 1) {
    // ── 5.16: Single project — auto-select, hide dropdown, show label ──
    projectSelect.value         = projects[0].projectId;
    projectDropdown.style.display = 'none';
    projectSingle.textContent   = projects[0].name;
    projectSingle.style.display = 'block';
    console.log('[Hammer popup] single project auto-selected:', projects[0].projectId);
    return;
  }

  // ── 5.16: Multiple projects — show dropdown, restore saved selection ──
  // Add a blank placeholder option at the top
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— select project —';
  projectSelect.insertBefore(placeholder, projectSelect.firstChild);

  // Restore previously saved project if it still exists in the list
  if (savedProjectId) {
    const exists = projects.some(p => p.projectId === savedProjectId);
    if (exists) {
      projectSelect.value = savedProjectId;
    } else {
      console.warn('[Hammer popup] saved projectId not in list:', savedProjectId);
      projectSelect.value = '';
    }
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
