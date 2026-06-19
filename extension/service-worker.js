// ─────────────────────────────────────────────────────────────────
// The Hammer — Service Worker
// Sprint 4 additions:
//   4.1 — offline queue in chrome.storage.local
//   4.2 — exponential backoff retry (max 3, 1s/2s/4s in same wake cycle)
//   4.3 — XHR upload with onprogress → chrome.runtime.sendMessage to popup
//   4.4 — atomic settings save (read from storage; save handled in popup.js)
//   4.5 — history: last 20 uploads (oldest dropped at 21)
// Sprint 5.15 changes:
//   — Removed session.userId guard: user identity is now resolved server-side
//     from the X-Api-Key header. The extension no longer manages userId.
//   — capture() returns { ok: false, reason: 'no_api_key' } when apiKey is
//     absent, so popup.js can surface a targeted banner.
//   — uploadBlobWithSignedUrl: removed `name: session.userId` from POST body;
//     backend derives userId from the API key lookup.
//   — session.userId removed from historyAppend calls (field left as empty
//     string so the history schema stays consistent).
//   — DEFAULT_CLOUD_RUN_URL updated to '' sentinel (unchanged from sprint 4);
//     the popup read-only default is https://app.thehammer.io/api, which is
//     written to settings by GET /config in task 5.17.
// ─────────────────────────────────────────────────────────────────

// CAPTURE response contract (authoritative):
// { ok: boolean, path?: string, reason?: string, error?: string }
// reason values: 'blocked' | 'no_api_key' | 'no_project'

const ICON_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
  'AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Sentinel: empty string means "not configured".
// The actual URL is stored in settings.cloudRunUrl by GET /config (task 5.17).
// Fallback default if storage is empty: https://app.thehammer.io/api
const DEFAULT_CLOUD_RUN_URL = '';
const FALLBACK_API_BASE = 'https://app.thehammer.io/api';

// ─────────────────────────────────────────────────────────────────
// 4.1 — Offline queue helpers
// Storage shape: { queue: [...], failed: [...] }
//   queue   — pending items to upload on next wake
//   failed  — items that exhausted all retries
// Each item: { blobBase64, session, tabUrl, ts, attempts }
// ─────────────────────────────────────────────────────────────────
async function queueGet() {
  const { queue = [], failed = [] } = await chrome.storage.local.get(['queue', 'failed']);
  return { queue, failed };
}

async function queueSave(queue, failed) {
  await chrome.storage.local.set({ queue, failed });
}

async function queueAdd(blobBase64, session, tabUrl) {
  const { queue, failed } = await queueGet();
  queue.push({ blobBase64, session, tabUrl, ts: Date.now(), attempts: 0 });
  await queueSave(queue, failed);
  console.log('[Hammer SW] queued offline item; queue length:', queue.length);
}

// ─────────────────────────────────────────────────────────────────
// 4.5 — History helpers
// Storage: { history: [ { path, size, ts, projectId, tool }, ... ] }
// Max 20 entries; oldest dropped when 21st is added.
// 5.15: userId removed from history entries; backend resolves it from the key.
// ─────────────────────────────────────────────────────────────────
async function historyAppend(entry) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift(entry);
  if (history.length > 20) history.pop();
  await chrome.storage.local.set({ history });
}

// ─────────────────────────────────────────────────────────────────
// 4.2 — Retry with exponential backoff
// Short delays (1s / 2s / 4s) inside a single wake cycle.
// ─────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRY_DELAYS_MS = [1000, 2000, 4000];

async function withRetry(uploadFn) {
  let lastErr;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await uploadFn();
      console.log(`[Hammer SW] upload succeeded on attempt ${attempt + 1}`);
      return result;
    } catch (err) {
      lastErr = err;
      console.warn(`[Hammer SW] attempt ${attempt + 1} failed:`, err.message);
      if (attempt < RETRY_DELAYS_MS.length - 1) {
        console.log(`[Hammer SW] retrying in ${RETRY_DELAYS_MS[attempt]}ms…`);
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────
// 4.3 — XHR PUT with upload progress
// ─────────────────────────────────────────────────────────────────
function xhrPut(url, blob) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'image/png');
    xhr.timeout = 30_000;

    xhr.upload.onprogress = (evt) => {
      if (!evt.lengthComputable) return;
      const pct = Math.round((evt.loaded / evt.total) * 100);
      chrome.runtime.sendMessage({ type: 'UPLOAD_PROGRESS', percent: pct }).catch(() => {});
      console.log(`[Hammer SW] upload progress: ${pct}%`);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        chrome.runtime.sendMessage({ type: 'UPLOAD_PROGRESS', percent: 100 }).catch(() => {});
        resolve(xhr.status);
      } else {
        reject(new Error(`GCS PUT HTTP ${xhr.status}: ${xhr.responseText.slice(0, 200)}`));
      }
    };

    xhr.onerror   = () => reject(new Error('XHR network error'));
    xhr.ontimeout = () => reject(new Error('XHR PUT timed out after 30s'));

    xhr.send(blob);
  });
}

// ─────────────────────────────────────────────────────────────────
// Drain offline queue on every service worker startup.
// ─────────────────────────────────────────────────────────────────
(async () => {
  const { queue, failed } = await queueGet();
  if (queue.length === 0) return;

  const { settings } = await chrome.storage.local.get('settings');
  const cloudRunUrl = settings?.cloudRunUrl?.trim() || FALLBACK_API_BASE;
  const apiKey      = settings?.apiKey?.trim() || '';
  if (!cloudRunUrl || !apiKey) return;

  console.log('[Hammer SW] draining offline queue:', queue.length, 'item(s)');

  const remaining = [];
  const newFailed  = [...failed];

  for (const item of queue) {
    try {
      const binaryStr = atob(item.blobBase64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/png' });

      const result = await withRetry(() =>
        uploadBlobWithSignedUrl(blob, item.session, item.tabUrl, cloudRunUrl, apiKey)
      );

      await historyAppend({
        path:      result.path,
        size:      blob.size,
        ts:        Date.now(),
        projectId: item.session.projectId,
        tool:      item.session.tool ?? ''
      });
      console.log('[Hammer SW] drained queued item ✓ | path:', result.path);
    } catch (err) {
      console.error('[Hammer SW] queued item failed all retries:', err.message);
      newFailed.push({ ...item, failedAt: Date.now(), error: err.message });
    }
  }

  await queueSave(remaining, newFailed);
  console.log('[Hammer SW] queue drain complete. remaining:', remaining.length, 'failed:', newFailed.length);
})();

// ── Install: inject content.js into already-open tabs ──
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

// ── Keyboard shortcut ──
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-screenshot') return;
  console.log('[Hammer SW] command fired:', command);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await capture(tab);
});

// ── Long-lived port from content script ──
const _openPorts = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'capture-port') return;
  _openPorts.set(port.sender?.tab?.id ?? 'unknown', port);
  port.onDisconnect.addListener(() => {
    _openPorts.delete(port.sender?.tab?.id ?? 'unknown');
    console.log('[Hammer SW] capture-port disconnected');
  });
});

// ── Messages from popup and content script ──
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
      } else if (result.reason) {
        sendResponse({ ok: false, reason: result.reason });
      } else {
        sendResponse({ ok: true, path: result.path });
      }
    })
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true;
});

// ─────────────────────────────────────────────────────────────────
// capture(tab) — shared by all three triggers
// Returns { path } on success, { reason } for soft blocks, or null if page-blocked.
//
// 5.15 changes:
//   — Removed session.userId guard (identity is server-side from X-Api-Key).
//   — Added no_api_key guard: returns { reason: 'no_api_key' } immediately
//     without a notification, so popup.js can show the targeted banner.
//   — session.projectId guard kept: user must still select a project.
// ─────────────────────────────────────────────────────────────────
async function capture(tab) {
  if (!tab || !tab.url ||
      tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('about:')) {
    await showNotification('Cannot capture this page', 'Navigate to a normal web page first.');
    return null;
  }

  // 4.4 — read all settings atomically
  const { settings } = await chrome.storage.local.get('settings');
  const cloudRunUrl = settings?.cloudRunUrl?.trim() || FALLBACK_API_BASE;
  const apiKey      = settings?.apiKey?.trim() || '';

  // 5.15: guard on API key, not userId
  if (!apiKey) {
    // Return reason so popup.js shows the targeted no-key banner
    // (no system notification — the popup is the right surface for this)
    console.warn('[Hammer SW] capture blocked: no API key set');
    return { reason: 'no_api_key' };
  }

  const { session } = await chrome.storage.local.get('session');
  if (!session || !session.projectId) {
    await showNotification('Project not set',
      'Open the popup, select a Project and press Save before capturing.');
    return null;
  }

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

  const blob = await fetch(dataUrl).then((r) => r.blob());
  if (!(blob instanceof Blob) || blob.type !== 'image/png' || blob.size === 0) {
    await showNotification('Capture failed', 'Could not convert screenshot to PNG blob.');
    return null;
  }

  console.log('[Hammer SW] captured PNG ✓ | size:', blob.size, '| project:', session.projectId);

  let uploadResult;
  try {
    uploadResult = await withRetry(() =>
      uploadBlobWithSignedUrl(blob, session, tab.url, cloudRunUrl, apiKey)
    );
  } catch (uploadErr) {
    console.error('[Hammer SW] all retries failed, queuing for later:', uploadErr.message);
    const base64 = await blobToBase64(blob);
    await queueAdd(base64, session, tab.url);
    await showNotification('Upload queued', 'No connection — will retry when online.');
    return null;
  }

  await historyAppend({
    path:      uploadResult.path,
    size:      blob.size,
    ts:        Date.now(),
    projectId: session.projectId,
    tool:      session.tool ?? ''
  });

  await showNotification('Screenshot uploaded ✓', uploadResult.path || 'Saved to GCS');
  console.log('[Hammer SW] upload ✓ | path:', uploadResult.path);
  return uploadResult;
}

// ─────────────────────────────────────────────────────────────────
// uploadBlobWithSignedUrl
// 5.15: removed `name: session.userId` from POST body.
//       Backend now resolves userId from sha256(X-Api-Key) lookup in api_keys.
// ─────────────────────────────────────────────────────────────────
async function uploadBlobWithSignedUrl(blob, session, tabUrl, cloudRunUrl, apiKey) {
  const controller1 = new AbortController();
  const t1 = setTimeout(() => controller1.abort(), 15_000);
  let signedUrlResponse;
  try {
    const res = await fetch(`${cloudRunUrl}/upload-url`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body:    JSON.stringify({
        project: session.projectId,
        tool:    session.tool ?? '',
        stage:   session.stage ?? ''
        // 5.15: `name` (userId) removed — backend derives from X-Api-Key
      }),
      signal: controller1.signal
    });
    clearTimeout(t1);
    if (!res.ok) {
      const text = await res.text().catch(() => res.status.toString());
      throw new Error(`/upload-url HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    signedUrlResponse = await res.json();
  } catch (err) {
    clearTimeout(t1);
    console.warn('[Hammer SW] /upload-url failed, using proxy:', err.message);
    return uploadViaProxy(blob, session, tabUrl, cloudRunUrl, apiKey);
  }

  console.log('[Hammer SW] signed URL received | path:', signedUrlResponse.path);

  try {
    await xhrPut(signedUrlResponse.signedUrl, blob);
  } catch (err) {
    console.warn('[Hammer SW] XHR PUT failed, using proxy:', err.message);
    return uploadViaProxy(blob, session, tabUrl, cloudRunUrl, apiKey);
  }

  return { path: signedUrlResponse.path };
}

// ─────────────────────────────────────────────────────────────────
// uploadViaProxy — Sprint 2 /capture fallback path
// 5.15: removed `userId` from FormData; backend resolves from X-Api-Key.
// ─────────────────────────────────────────────────────────────────
async function uploadViaProxy(blob, session, tabUrl, cloudRunUrl, apiKey) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 15_000);

  const formData = new FormData();
  formData.append('file',      blob, 'screenshot.png');
  formData.append('projectId', session.projectId);
  formData.append('tool',      session.tool ?? '');
  formData.append('stage',     session.stage ?? '');
  formData.append('tabUrl',    tabUrl ?? '');
  // 5.15: userId omitted — resolved server-side from X-Api-Key

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
    throw err;
  }
}

// ── Helpers ──
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

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
