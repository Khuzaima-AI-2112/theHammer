// popup.js — always a separate file, never inline onclick in HTML (task 1.5)
// Handles: storage load/save (1.3), dropdowns from config (1.13),
//          session persistence (1.14), capture message (1.5), admin link (1.11).

// ── Seed config used on first run before admin sets anything (task 1.13) ──
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

const projectSelect    = document.getElementById('project-select');
const userSelect       = document.getElementById('user-select');
const toolInput        = document.getElementById('tool-input');
const saveBtn          = document.getElementById('save-btn');
const captureBtn       = document.getElementById('capture-btn');
const adminLink        = document.getElementById('admin-link');
const openAdminBanner  = document.getElementById('open-admin-banner');
const seedBanner       = document.getElementById('seed-banner');
const statusEl         = document.getElementById('status');

document.addEventListener('DOMContentLoaded', async () => {
  // ── Load config + session from storage (tasks 1.13, 1.14) ──
  let { config, session } = await chrome.storage.local.get(['config', 'session']);

  if (!config) {
    // First run: use seed list and show persistent banner (task 1.13)
    config = SEED_CONFIG;
    seedBanner.style.display = 'block';
  }

  populateSelect(projectSelect, config.projects);
  populateSelect(userSelect, config.users);

  // ── Restore saved session (task 1.14) ──
  if (session) {
    if (session.projectId) projectSelect.value = session.projectId;
    if (session.userId)    userSelect.value    = session.userId;
    if (session.tool)      toolInput.value     = session.tool;
  }

  // ── Save button (task 1.14) ──
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

  // ── Capture Now button (task 1.5) ──
  captureBtn.addEventListener('click', () => {
    setStatus('Capturing…');
    chrome.runtime.sendMessage({ type: 'CAPTURE' }, (response) => {
      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message);
        return;
      }
      if (response?.ok) {
        setStatus('Captured ✓ (' + response.length + ' chars)');
      } else if (response?.reason === 'blocked') {
        // fix #3: blocked capture is clearly surfaced, not shown as success
        setStatus('Blocked — set Project & User first.');
      } else {
        setStatus('Failed: ' + (response?.error ?? 'unknown'));
      }
    });
  });

  // ── Admin link — both footer button and banner button (task 1.11) ──
  function openAdmin() {
    chrome.tabs.create({ url: chrome.runtime.getURL('admin.html') });
  }
  adminLink.addEventListener('click', openAdmin);
  openAdminBanner.addEventListener('click', openAdmin);
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
