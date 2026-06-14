// ─────────────────────────────────────────────────────────────────
// The Hammer — Service Worker (Sprint 1)
// No backend yet: capture goes to console only.
// ─────────────────────────────────────────────────────────────────

// Notification icon: a 1x1 teal PNG as a data URI.
// chrome.notifications.create requires an iconUrl — a missing or broken
// icon causes silent failure on some platforms.
const ICON_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
  'AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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

// ── 3. Long-lived port from content script (task 1.10) ──
// No-op handler: prevents Chrome from logging
// "Could not establish connection. Receiving end does not exist."
// The port is used purely to keep the service worker alive during capture.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'capture-port') return;
  // Keep port reference; disconnect is driven by content.js after sendResponse.
  port.onDisconnect.addListener(() => {
    console.log('[Hammer SW] capture-port disconnected');
  });
});

// ── 4. Messages from popup and content script (tasks 1.5, 1.6, 1.10) ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'CAPTURE') return false;

  // Only accept messages from top-level frames (task 1.6)
  // sender.tab is undefined for popup messages — that's intentional.
  if (sender.tab && sender.frameId !== 0) return false;

  const tabPromise = sender.tab
    ? Promise.resolve(sender.tab)
    : chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t);

  tabPromise
    .then((tab) => capture(tab))
    .then((result) => {
      if (result === null) {
        // Capture was blocked (page guard or session guard) — fix #3
        sendResponse({ ok: false, reason: 'blocked' });
      } else {
        sendResponse({ ok: true, length: result.length });
      }
    })
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true; // keep message channel open for async response
});

// ─────────────────────────────────────────────────────────────────
// capture(tab) — shared by all three triggers
// Returns the data URL string on success, or null if blocked.
// ─────────────────────────────────────────────────────────────────
async function capture(tab) {
  // ── Guard: restricted pages (task 1.8) ──
  if (!tab || !tab.url ||
      tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('about:')) {
    await showNotification(
      'Cannot capture this page',
      'Navigate to a normal web page first.'
    );
    return null;
  }

  // ── Guard: session must have project + user (task 1.15) ──
  const { session } = await chrome.storage.local.get('session');
  if (!session || !session.projectId || !session.userId) {
    await showNotification(
      'Project / User not set',
      'Open the popup and save a Project and User before capturing.'
    );
    return null;
  }

  // ── Capture (tasks 1.4, 1.9) ──
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

  console.log(
    '[Hammer SW] captured PNG ✓',
    '| length:', dataUrl.length,
    '| project:', session.projectId,
    '| user:', session.userId,
    '| tool:', session.tool ?? '(none)'
  );

  return dataUrl;
}

// ─────────────────────────────────────────────────────────────────
// showNotification — uses a data URI iconUrl so no file resolution needed
// ─────────────────────────────────────────────────────────────────
function showNotification(title, message) {
  return new Promise((resolve) => {
    chrome.notifications.create('', {
      type: 'basic',
      iconUrl: ICON_DATA_URI,
      title,
      message
    }, resolve);
  });
}
