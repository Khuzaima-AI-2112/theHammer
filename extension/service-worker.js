// ─────────────────────────────────────────────────────────────────
// The Hammer — Service Worker (Sprint 1)
// No backend yet: capture goes to console only.
// ─────────────────────────────────────────────────────────────────

// ── 1. Install: inject content.js into already-open tabs (task 1.6) ──
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
    } catch (e) {
      // Restricted page (e.g. chrome:// or file://) — ignore silently
    }
  }
  console.log('[Hammer SW] installed; injected content.js into', tabs.length, 'open tabs');
});

// ── 2. Keyboard shortcut (task 1.4) ──
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-screenshot') return;
  console.log('[Hammer SW] command fired:', command);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await capture(tab);
});

// ── 3. Messages from popup and content script (tasks 1.5, 1.6, 1.10) ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'CAPTURE') return;

  // Determine which tab to capture
  const tabPromise = sender.tab
    ? Promise.resolve(sender.tab)                                    // from content script
    : chrome.tabs.query({ active: true, currentWindow: true })       // from popup
        .then(([t]) => t);

  // Keep service worker alive: hold port open (task 1.10)
  // The content script connects before sending, then disconnects on response.
  // For popup messages there is no port — the async response keeps the worker alive.
  tabPromise
    .then((tab) => capture(tab))
    .then((dataUrl) => sendResponse({ ok: true, length: dataUrl?.length ?? 0 }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true; // keep the message channel open for the async response
});

// ─────────────────────────────────────────────────────────────────
// capture(tab) — core capture logic shared by all three triggers
// ─────────────────────────────────────────────────────────────────
async function capture(tab) {
  // ── Guard: chrome:// and restricted pages (task 1.8) ──
  if (!tab || !tab.url || tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('about:')) {
    await showNotification(
      'Cannot capture this page',
      'The Hammer cannot capture browser UI pages. Navigate to a normal web page first.'
    );
    return null;
  }

  // ── Guard: session must have project + user set (task 1.15) ──
  const { session } = await chrome.storage.local.get('session');
  if (!session || !session.projectId || !session.userId) {
    await showNotification(
      'Project / User not set',
      'Open The Hammer popup and save a Project and User before capturing.'
    );
    return null;
  }

  // ── Capture (task 1.4, 1.9) ──
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (err) {
    await showNotification('Capture failed', err.message);
    throw err;
  }

  // ── Validate (task 1.9) ──
  if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length < 10000) {
    console.error('[Hammer SW] unexpected dataUrl:', dataUrl.slice(0, 80));
    await showNotification('Capture failed', 'Screenshot data looks invalid. Try again.');
    return null;
  }

  console.log('[Hammer SW] captured PNG, length:', dataUrl.length,
    '| project:', session.projectId,
    '| user:', session.userId,
    '| tool:', session.tool ?? '(none)');

  return dataUrl;
}

// ─────────────────────────────────────────────────────────────────
// showNotification — thin wrapper so every call includes iconUrl
// (required on some platforms — task 2.11 note)
// ─────────────────────────────────────────────────────────────────
function showNotification(title, message) {
  return new Promise((resolve) => {
    chrome.notifications.create(
      '',
      {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title,
        message
      },
      resolve
    );
  });
}
