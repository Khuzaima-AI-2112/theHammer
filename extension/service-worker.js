// ─────────────────────────────────────────────────────────────────
// The Hammer — Service Worker (Sprint 2, fixes applied per lessons_learned.md)
// POST /capture   → blob convert → upload to Cloud Run → GCS
// ─────────────────────────────────────────────────────────────────

// CAPTURE response contract (authoritative — update all consumers when this changes):
// { ok: boolean, path?: string, reason?: string, error?: string }
// Consumers: content.js (floating button), popup.js (Capture Now button)

// Notification icon: a 1×1 teal PNG as a data URI.
// chrome.notifications.create requires an iconUrl — a missing or broken
// icon causes silent failure on some platforms.
const ICON_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
  'AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Item 4 fix (lessons_learned.md): deliberately empty sentinel.
// An empty string triggers the explicit guard below so the user gets an
// immediate notification instead of a silent 15-second AbortController hang.
// DO NOT replace '' with a placeholder URL like 'https://YOUR_CLOUD_RUN_URL' —
// that string passes the URL guard and causes a real DNS lookup + timeout.
const DEFAULT_CLOUD_RUN_URL = '';

// ── 1. Install: inject content.js into already-open tabs ──
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

// ── 2. Keyboard shortcut ──
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-screenshot') return;
  console.log('[Hammer SW] command fired:', command);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await capture(tab);
});

// ── 3. Long-lived port from content script ──
// Kept open for the FULL upload duration — not just capture.
// Closed only after sendResponse fires inside capture().
const _openPorts = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'capture-port') return;
  _openPorts.set(port.sender?.tab?.id ?? 'unknown', port);
  port.onDisconnect.addListener(() => {
    _openPorts.delete(port.sender?.tab?.id ?? 'unknown');
    console.log('[Hammer SW] capture-port disconnected');
  });
});

// ── 4. Messages from popup and content script ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'CAPTURE') return false;

  // Only accept messages from top-level frames
  if (sender.tab && sender.frameId !== 0) return false;

  const tabPromise = sender.tab
    ? Promise.resolve(sender.tab)
    : chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t);

  tabPromise
    .then((tab) => capture(tab))
    .then((result) => {
      if (result === null) {
        sendResponse({ ok: false, reason: 'blocked' });
      } else {
        sendResponse({ ok: true, path: result.path });
      }
    })
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true; // keep message channel open for async response
});

// ─────────────────────────────────────────────────────────────────
// capture(tab) — shared by all three triggers
// Returns { path, size } on success, or null if blocked.
// ─────────────────────────────────────────────────────────────────
async function capture(tab) {
  // ── Guard: restricted pages ──
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

  // ── Guard: session must have project + user ──
  const { session } = await chrome.storage.local.get('session');
  if (!session || !session.projectId || !session.userId) {
    await showNotification(
      'Project / User not set',
      'Open the popup and save a Project and User before capturing.'
    );
    return null;
  }

  // ── Load settings (Cloud Run URL + API key) ──
  const { settings } = await chrome.storage.local.get('settings');
  const cloudRunUrl = settings?.cloudRunUrl?.trim() || DEFAULT_CLOUD_RUN_URL;
  const apiKey      = settings?.apiKey?.trim() || '';

  // Item 4 fix: explicit empty-string guard — fires immediately, no network attempt.
  if (!cloudRunUrl) {
    await showNotification(
      'Cloud Run URL not set',
      'Open popup ⚙ Settings and enter your Cloud Run URL before capturing.'
    );
    return null;
  }

  if (!apiKey) {
    await showNotification(
      'API key not set',
      'Open popup ⚙ Settings and enter your API key before capturing.'
    );
    return null;
  }

  // ── Capture screenshot ──
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (err) {
    await showNotification('Capture failed', err.message);
    throw err;
  }

  // ── Validate ──
  if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length < 10000) {
    console.error('[Hammer SW] unexpected dataUrl:', dataUrl.slice(0, 80));
    await showNotification('Capture failed', 'Screenshot data looks invalid. Try again.');
    return null;
  }

  // ── Task 2.9: Convert data URL → Blob ──
  const blob = await fetch(dataUrl).then((r) => r.blob());
  if (!(blob instanceof Blob) || blob.type !== 'image/png') {
    await showNotification('Capture failed', 'Could not convert screenshot to PNG blob.');
    return null;
  }
  if (blob.size === 0) {
    await showNotification('Capture failed', 'Screenshot blob is empty.');
    return null;
  }

  console.log(
    '[Hammer SW] captured PNG ✓',
    '| size:', blob.size,
    '| project:', session.projectId,
    '| user:', session.userId,
    '| tool:', session.tool ?? '(none)'
  );

  // ── Task 2.10 + 2.12: Upload with AbortController (15 s timeout) ──
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 15_000);

  const formData = new FormData();
  formData.append('file',      blob, 'screenshot.png');
  formData.append('projectId', session.projectId);
  formData.append('userId',    session.userId);
  formData.append('tool',      session.tool ?? '');
  formData.append('tabUrl',    tab.url ?? '');

  let uploadResult;
  try {
    const response = await fetch(`${cloudRunUrl}/capture`, {
      method:  'POST',
      headers: { 'X-Api-Key': apiKey },
      body:    formData,
      signal:  controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text().catch(() => response.status.toString());
      throw new Error(`Upload failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
    }

    uploadResult = await response.json();
  } catch (err) {
    clearTimeout(timeoutId);
    // ── Task 2.12: Error notification ──
    const isTimeout = err.name === 'AbortError';
    await showNotification(
      isTimeout ? 'Upload timed out' : 'Upload failed',
      isTimeout ? 'Server did not respond within 15 s.' : err.message.slice(0, 200)
    );
    return null;
  }

  // ── Task 2.11: Success notification with GCS path ──
  await showNotification(
    'Screenshot uploaded ✓',
    uploadResult.path || 'Saved to GCS'
  );

  console.log('[Hammer SW] upload ✓ | path:', uploadResult.path, '| size:', uploadResult.size);
  return uploadResult;
}

// ─────────────────────────────────────────────────────────────────
// showNotification — uses a data URI iconUrl so no file resolution needed
// ─────────────────────────────────────────────────────────────────
function showNotification(title, message) {
  return new Promise((resolve) => {
    chrome.notifications.create('', {
      type:    'basic',
      iconUrl: ICON_DATA_URI,
      title,
      message
    }, resolve);
  });
}
