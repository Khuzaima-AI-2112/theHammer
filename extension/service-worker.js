// ─────────────────────────────────────────────────────────────────
// The Hammer — Service Worker (Sprint 3)
// Primary path:  POST /upload-url → PUT blob directly to GCS signed URL
// Fallback path: POST /capture    → Cloud Run proxies bytes to GCS
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
// DO NOT replace '' with a placeholder URL — that passes the guard and causes
// a real DNS lookup + timeout.
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
      // Restricted page — ignore silently
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

  return true;
});

// ─────────────────────────────────────────────────────────────────
// capture(tab) — shared by all three triggers
// Returns { path } on success, or null if blocked.
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

  // ── Load settings ──
  const { settings } = await chrome.storage.local.get('settings');
  const cloudRunUrl = settings?.cloudRunUrl?.trim() || DEFAULT_CLOUD_RUN_URL;
  const apiKey      = settings?.apiKey?.trim() || '';

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

  if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length < 10000) {
    console.error('[Hammer SW] unexpected dataUrl:', dataUrl.slice(0, 80));
    await showNotification('Capture failed', 'Screenshot data looks invalid. Try again.');
    return null;
  }

  // ── Convert data URL → Blob (task 2.9) ──
  const blob = await fetch(dataUrl).then((r) => r.blob());
  if (!(blob instanceof Blob) || blob.type !== 'image/png' || blob.size === 0) {
    await showNotification('Capture failed', 'Could not convert screenshot to PNG blob.');
    return null;
  }

  console.log(
    '[Hammer SW] captured PNG ✓',
    '| size:', blob.size,
    '| project:', session.projectId,
    '| user:', session.userId,
    '| tool:', session.tool ?? '(none)'
  );

  // ─────────────────────────────────────────────────────────────────
  // Sprint 3 — Primary upload path
  //
  // Task 3.5: POST /upload-url → get { signedUrl, path }
  // Task 3.6: PUT blob directly to GCS signed URL
  //           Content-Type MUST be 'image/png' — identical to what was signed.
  //           A mismatch causes a silent 403.
  // Task 3.7: On ANY /upload-url failure, fall back to uploadViaProxy().
  //           uploadViaProxy() is a named function shared by both paths —
  //           no code divergence.
  // ─────────────────────────────────────────────────────────────────
  let uploadResult;

  try {
    // ── Task 3.5: Request signed URL from Cloud Run ──
    const controller1  = new AbortController();
    const timeoutId1   = setTimeout(() => controller1.abort(), 15_000);

    let signedUrlResponse;
    try {
      const res = await fetch(`${cloudRunUrl}/upload-url`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key':    apiKey
        },
        body:   JSON.stringify({
          project: session.projectId,
          tool:    session.tool ?? '',
          name:    session.userId
        }),
        signal: controller1.signal
      });
      clearTimeout(timeoutId1);

      if (!res.ok) {
        const text = await res.text().catch(() => res.status.toString());
        throw new Error(`/upload-url HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      signedUrlResponse = await res.json();
    } catch (err) {
      clearTimeout(timeoutId1);
      throw err; // caught by outer try → falls back to uploadViaProxy()
    }

    // Task 3.5: log signed URL on first successful run
    console.log('[Hammer SW] signed URL received | path:', signedUrlResponse.path);
    console.log('[Hammer SW] signed URL:', signedUrlResponse.signedUrl);

    // ── Task 3.6: PUT blob directly to GCS ──
    // Content-Type: image/png — MUST match what Cloud Run signed (identical string).
    const controller2 = new AbortController();
    const timeoutId2  = setTimeout(() => controller2.abort(), 30_000); // larger for direct upload

    try {
      const putRes = await fetch(signedUrlResponse.signedUrl, {
        method:  'PUT',
        headers: { 'Content-Type': 'image/png' },
        body:    blob,
        signal:  controller2.signal
      });
      clearTimeout(timeoutId2);

      if (!putRes.ok) {
        // 403 here almost always means Content-Type mismatch (task 3.6 warning)
        const text = await putRes.text().catch(() => putRes.status.toString());
        throw new Error(`GCS PUT HTTP ${putRes.status}: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      clearTimeout(timeoutId2);
      throw err; // caught by outer try → falls back to uploadViaProxy()
    }

    uploadResult = { path: signedUrlResponse.path };
    console.log('[Hammer SW] direct upload ✓ | path:', uploadResult.path);

  } catch (signedUrlErr) {
    // ── Task 3.7: Fallback to /capture on any /upload-url or PUT failure ──
    console.warn('[Hammer SW] signed URL path failed, falling back to proxy:', signedUrlErr.message);
    uploadResult = await uploadViaProxy(blob, session, tab, cloudRunUrl, apiKey);
    if (!uploadResult) return null; // uploadViaProxy already showed notification
  }

  // ── Task 2.11: Success notification with GCS path ──
  await showNotification(
    'Screenshot uploaded ✓',
    uploadResult.path || 'Saved to GCS'
  );

  console.log('[Hammer SW] upload ✓ | path:', uploadResult.path);
  return uploadResult;
}

// ─────────────────────────────────────────────────────────────────
// uploadViaProxy — Sprint 2 /capture path, extracted as a named function.
//
// Task 3.7 requirement: named function called by BOTH the fallback catch
// block above AND directly if needed — no code divergence between paths.
//
// Returns { path, size } on success, or null on failure
// (shows notification internally on failure).
// ─────────────────────────────────────────────────────────────────
async function uploadViaProxy(blob, session, tab, cloudRunUrl, apiKey) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 15_000);

  const formData = new FormData();
  formData.append('file',      blob, 'screenshot.png');
  formData.append('projectId', session.projectId);
  formData.append('userId',    session.userId);
  formData.append('tool',      session.tool ?? '');
  formData.append('tabUrl',    tab.url ?? '');

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
      throw new Error(`/capture HTTP ${response.status} — ${text.slice(0, 200)}`);
    }

    const result = await response.json();
    console.log('[Hammer SW] proxy upload ✓ | path:', result.path);
    return result;

  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err.name === 'AbortError';
    await showNotification(
      isTimeout ? 'Upload timed out' : 'Upload failed',
      isTimeout ? 'Server did not respond within 15 s.' : err.message.slice(0, 200)
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// showNotification
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
