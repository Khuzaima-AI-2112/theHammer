// popup.js — always a separate file, never inline onclick in HTML (task 1.5)
// Sprint 2 adds: Settings panel with Cloud Run URL + API key (task 2.13)

// ── Seed config used on first run before admin sets anything ──
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

const projectSelect   = document.getElementById('project-select');
const userSelect      = document.getElementById('user-select');
const toolInput       = document.getElementById('tool-input');
const saveBtn         = document.getElementById('save-btn');
const captureBtn      = document.getElementById('capture-btn');
const adminLink       = document.getElementById('admin-link');
const openAdminBanner = document.getElementById('open-admin-banner');
const seedBanner      = document.getElementById('seed-banner');
const statusEl        = document.getElementById('status');

// Settings panel elements (task 2.13)
const settingsToggle  = document.getElementById('settings-toggle');
const settingsPanel   = document.getElementById('settings-panel');
const cloudRunUrlInput= document.getElementById('cloud-run-url');
const apiKeyInput     = document.getElementById('api-key-input');
const urlError        = document.getElementById('url-error');
const settingsSaveBtn = document.getElementById('settings-save-btn');

document.addEventListener('DOMContentLoaded', async () => {
  // ── Load config + session + settings from storage ──
  let { config, session, settings } = await chrome.storage.local.get(['config', 'session', 'settings']);

  if (!config) {
    config = SEED_CONFIG;
    seedBanner.style.display = 'block';
  }

  populateSelect(projectSelect, config.projects);
  populateSelect(userSelect, config.users);

  // ── Restore saved session ──
  if (session) {
    if (session.projectId) projectSelect.value = session.projectId;
    if (session.userId)    userSelect.value    = session.userId;
    if (session.tool)      toolInput.value     = session.tool;
  }

  // ── Restore saved settings ──
  if (settings) {
    if (settings.cloudRunUrl) cloudRunUrlInput.value = settings.cloudRunUrl;
    if (settings.apiKey)      apiKeyInput.value      = settings.apiKey;
  }

  // ── Save session button ──
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

  // ── Capture Now button ──
  captureBtn.addEventListener('click', () => {
    setStatus('Capturing…');
    chrome.runtime.sendMessage({ type: 'CAPTURE' }, (response) => {
      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message);
        return;
      }
      if (response?.ok) {
        setStatus('Uploaded ✓');
      } else if (response?.reason === 'blocked') {
        setStatus('Blocked — set Project & User first.');
      } else {
        setStatus('Failed: ' + (response?.error ?? 'unknown'));
      }
    });
  });

  // ── Admin link ──
  function openAdmin() {
    chrome.tabs.create({ url: chrome.runtime.getURL('admin.html') });
  }
  adminLink.addEventListener('click', openAdmin);
  openAdminBanner.addEventListener('click', openAdmin);

  // ── Settings toggle (task 2.13) ──
  settingsToggle.addEventListener('click', () => {
    settingsPanel.classList.toggle('open');
    settingsToggle.textContent = settingsPanel.classList.contains('open')
      ? '✕ Settings'
      : '⚙ Settings';
  });

  // ── Settings save (task 2.13) ──
  // Validates https:// prefix before saving; shows inline error if invalid.
  settingsSaveBtn.addEventListener('click', async () => {
    const rawUrl = cloudRunUrlInput.value.trim();
    const key    = apiKeyInput.value.trim();

    // Validate URL — must start with https://
    if (rawUrl && !rawUrl.startsWith('https://')) {
      urlError.style.display = 'block';
      cloudRunUrlInput.focus();
      return;
    }
    urlError.style.display = 'none';

    try {
      await chrome.storage.local.set({
        settings: { cloudRunUrl: rawUrl, apiKey: key }
      });
      setStatus('Settings saved ✓');
    } catch (err) {
      console.error('[Hammer popup] settings save error:', err);
      setStatus('Settings save failed: ' + err.message);
    }
  });

  // Hide url-error when user edits the field
  cloudRunUrlInput.addEventListener('input', () => {
    urlError.style.display = 'none';
  });
});

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
