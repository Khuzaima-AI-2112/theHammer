// admin.js — Admin config UI (tasks 1.11, 1.12)
// Schema: chrome.storage.local key `config` = { projects: [...], users: [...] }
// Each item: { id: string, name: string }
// Pure add/remove functions are exported at bottom for unit testing.

// ── DOM refs ──
const newProjectInput  = document.getElementById('new-project');
const addProjectBtn    = document.getElementById('add-project-btn');
const projectList      = document.getElementById('project-list');
const newUserInput     = document.getElementById('new-user');
const addUserBtn       = document.getElementById('add-user-btn');
const userList         = document.getElementById('user-list');
const statusEl         = document.getElementById('status');

// ── In-memory config (synced to storage on every change) ──
let config = { projects: [], users: [] };

// ─────────────────────────────────────────────────────────────────
// Pure helper functions (unit-testable — task 1.12)
// ─────────────────────────────────────────────────────────────────
function addItem(list, name) {
  const trimmed = name.trim();
  if (!trimmed) return list;
  const id = 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  return [...list, { id, name: trimmed }];
}

function removeItem(list, id) {
  return list.filter((item) => item.id !== id);
}

// ─────────────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────────────
async function loadConfig() {
  const result = await chrome.storage.local.get('config');
  if (result.config) {
    config = result.config;
  }
}

async function saveConfig() {
  try {
    await chrome.storage.local.set({ config });
    setStatus('Saved ✓');
  } catch (err) {
    console.error('[Hammer admin] save error:', err);
    setStatus('Save failed: ' + err.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────
function renderList(ulEl, items, onRemove) {
  ulEl.innerHTML = '';
  if (!items.length) {
    ulEl.innerHTML = '<li class="empty">None yet</li>';
    return;
  }
  items.forEach(({ id, name }) => {
    const li = document.createElement('li');
    li.innerHTML =
      `<span>${name}<span class="id">${id}</span></span>` +
      `<button data-id="${id}" title="Remove" aria-label="Remove ${name}">✕</button>`;
    li.querySelector('button').addEventListener('click', () => onRemove(id));
    ulEl.appendChild(li);
  });
}

function renderAll() {
  renderList(projectList, config.projects, async (id) => {
    config = { ...config, projects: removeItem(config.projects, id) };
    renderAll();
    await saveConfig();
  });
  renderList(userList, config.users, async (id) => {
    config = { ...config, users: removeItem(config.users, id) };
    renderAll();
    await saveConfig();
  });
}

// ─────────────────────────────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────────────────────────────
addProjectBtn.addEventListener('click', async () => {
  const name = newProjectInput.value;
  if (!name.trim()) return;
  config = { ...config, projects: addItem(config.projects, name) };
  newProjectInput.value = '';
  renderAll();
  await saveConfig();
});

newProjectInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addProjectBtn.click();
});

addUserBtn.addEventListener('click', async () => {
  const name = newUserInput.value;
  if (!name.trim()) return;
  config = { ...config, users: addItem(config.users, name) };
  newUserInput.value = '';
  renderAll();
  await saveConfig();
});

newUserInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addUserBtn.click();
});

// ─────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  renderAll();
});

// ─────────────────────────────────────────────────────────────────
// Export pure functions for unit tests (task 1.12)
// In a module build these would be ES module exports.
// For the unpacked extension they are attached to window so a test
// runner loaded in the same page context can import them.
// ─────────────────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.__hammerAdmin = { addItem, removeItem };
}

// ─────────────────────────────────────────────────────────────────
// Status helper
// ─────────────────────────────────────────────────────────────────
function setStatus(msg) {
  statusEl.textContent = msg;
  setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 3000);
}
