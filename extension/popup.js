// popup.js — Sprint 4
// 4.3: progress bar via UPLOAD_PROGRESS messages from service worker
// 4.4: all 5 settings fields saved atomically as { settings: {...} }
// 4.5: history tab showing last 20 uploads

const SEED_CONFIG = {
  projects: [
    { id: 'proj-seed-1', name: 'Sample Project A' },
    { id: 'proj-seed-2', name: 'Sample Project B' }
  ],
  users: [
    { id: 'user-seed-1', name: 'Alice' },
    { id: 'user-seed-2', name: 'Bob' }
  ]
};

// ── Element refs ──
const projectSelect    = document.getElementById('project-select');
const userSelect       = document.getElementById('user-select');
const toolInput        = document.getElementById('tool-input');
const saveBtn          = document.getElementById('save-btn');
const captureBtn       = document.getElementById('capture-btn');
const adminLink        = document.getElementById('admin-link');
const openAdminBanner  = document.getElementById('open-admin-banner');
const seedBanner       = document.getElementById('seed-banner');
const statusEl         = document.getElementById('status');
const progressBar      = document.getElementById('progress-bar');
const progressWrap     = document.getElementById('progress-wrap');

// Settings panel (task 2.13 + 4.4)
const settingsToggle   = document.getElementById('settings-toggle');
const settingsPanel    = document.getElementById('settings-panel');
const cloudRunUrlInput = document.getElementById('cloud-run-url');
const apiKeyInput      = document.getElementById('api-key-input');
const retentionInput   = document.getElementById('retention-input');
const maxSizeInput     = document.getElementById('max-size-input');
const notifyInput      = document.getElementById('notify-input');
const urlError         = document.getElementById('url-error');
const settingsSaveBtn  = document.getElementById('settings-save-btn');

// History tab (task 4.5)
const tabCapture       = document.getElementById('tab-capture');
const tabHistory       = document.getElementById('tab-history');
const capturePanel     = document.getElementById('capture-panel');
const historyPanel     = document.getElementById('history-panel');
const historyList      = document.getElementById('history-list');

document.addEventListener('DOMContentLoaded', async () => {
  let { config, session, settings } = await chrome.storage.local.get(['config', 'session', 'settings']);

  if (!config) {
    config = SEED_CONFIG;
    seedBanner.style.display = 'block';
  }

  populateSelect(projectSelect, config.projects);
  populateSelect(userSelect, config.users);

  if (session) {
    if (session.projectId) projectSelect.value = session.projectId;
    if (session.userId)    userSelect.value    = session.userId;
    if (session.tool)      toolInput.value     = session.tool;
  }

  // 4.4 — restore all 5 settings fields
  if (settings) {
    if (settings.cloudRunUrl) cloudRunUrlInput.value = settings.cloudRunUrl;
    if (settings.apiKey)      apiKeyInput.value      = settings.apiKey;
    if (settings.retention)   retentionInput.value   = settings.retention;
    if (settings.maxSize)     maxSizeInput.value     = settings.maxSize;
    if (settings.notify != null) notifyInput.checked = settings.notify;
  }

  // ── Save session ──
  saveBtn.addEventListener('click', async () => {
    const s = {
      projectId: projectSelect.value,
      userId:    userSelect.value,
      tool:      toolInput.value.trim()
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
        setStatus('Blocked — set Project & User first.');
      } else {
        setStatus('Failed: ' + (response?.error ?? 'unknown'));
      }
    });
  });

  // ── 4.3 — listen for upload progress from service worker ──
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'UPLOAD_PROGRESS') {
      showProgress(message.percent);
    }
  });

  // ── Admin link ──
  function openAdmin() {
    chrome.tabs.create({ url: chrome.runtime.getURL('admin.html') });
  }
  adminLink.addEventListener('click', openAdmin);
  openAdminBanner.addEventListener('click', openAdmin);

  // ── Settings toggle ──
  settingsToggle.addEventListener('click', () => {
    settingsPanel.classList.toggle('open');
    settingsToggle.textContent = settingsPanel.classList.contains('open')
      ? '✕ Settings'
      : '⚙ Settings';
  });

  // ── 4.4 — Settings save: all 5 fields in ONE atomic write ──
  settingsSaveBtn.addEventListener('click', async () => {
    const rawUrl = cloudRunUrlInput.value.trim();
    if (rawUrl && !rawUrl.startsWith('https://')) {
      urlError.style.display = 'block';
      cloudRunUrlInput.focus();
      return;
    }
    urlError.style.display = 'none';

    const allSettings = {
      cloudRunUrl: rawUrl,
      apiKey:      apiKeyInput.value.trim(),
      retention:   retentionInput.value.trim(),
      maxSize:     maxSizeInput.value.trim(),
      notify:      notifyInput.checked
    };

    try {
      // Single atomic write — all 5 fields together
      await chrome.storage.local.set({ settings: allSettings });
      setStatus('Settings saved ✓');
    } catch (err) {
      console.error('[Hammer popup] settings save error:', err);
      setStatus('Settings save failed: ' + err.message);
    }
  });

  cloudRunUrlInput.addEventListener('input', () => { urlError.style.display = 'none'; });

  // ── 4.5 — Tab switching ──
  tabCapture.addEventListener('click', () => switchTab('capture'));
  tabHistory.addEventListener('click', () => {
    switchTab('history');
    refreshHistory();
  });

  // Load history on open in case user starts on capture tab then switches
  refreshHistory();
});

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

// ── History ──
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
function populateSelect(selectEl, items) {
  while (selectEl.options.length > 1) selectEl.remove(1);
  (items || []).forEach(({ id, name }) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    selectEl.appendChild(opt);
  });
}

function setStatus(msg) {
  statusEl.textContent = msg;
  setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 4000);
}
