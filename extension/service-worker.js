// ─────────────────────────────────────────────────────────────────
// The Hammer — Service Worker
// Sprint 6 additions (6.1–6.3):
//   6.1 — sessionStart logged on first capture of a session.
//          First uploads doc gets isFirstInSession: true + sessionStart ISO.
//          Session state stored in chrome.storage.session (survives SW restart,
//          cleared when all Chrome windows close).
//   6.2 — sessionEnd double-flush:
//          (a) chrome.runtime.onSuspend  — fires before SW is killed
//          (b) chrome.windows.onRemoved  — fires when last window closes
//          Both write a session_events doc to POST /session-events.
//          A flushed flag in chrome.storage.session prevents double-write.
//   6.3 — session_events doc contains all required fields:
//          sessionId, projectId, userId (resolved server-side), sessionStart,
//          sessionEnd, totalCaptures, firstCapturePath, lastCapturePath,
//          schemaVersion: 1, deleteAfter (sessionStart + 365 days ISO).
// Sprint 5.15 changes (retained):
//   — userId guard removed; identity resolved server-side via X-Api-Key.
//   — capture() returns { reason: 'no_api_key' } when key absent.
//   — uploadBlobWithSignedUrl: userId removed from POST body.
// Sprint 4 additions (retained):
//   4.1 — offline queue in chrome.storage.local
//   4.2 — exponential backoff retry (max 3, 1s/2s/4s)
//   4.3 — XHR upload with onprogress → chrome.runtime.sendMessage
//   4.4 — atomic settings read
//   4.5 — history: last 20 uploads
// ─────────────────────────────────────────────────────────────────

// CAPTURE response contract (authoritative):
// { ok: boolean, path?: string, reason?: string, error?: string }
// reason values: 'blocked' | 'no_api_key' | 'no_project'

const ICON_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
  'AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const FALLBACK_API_BASE = 'https://app.thehammer.io/api';

// ─────────────────────────────────────────────────────────────────
// 6.1 / 6.2 / 6.3 — Session state helpers
//
// chrome.storage.session shape:
// {
//   activeSession: {
//     sessionId:        string   (crypto.randomUUID())
//     projectId:        string
//     sessionStart:     ISO string
//     totalCaptures:    number
//     firstCapturePath: string
//     lastCapturePath:  string
//     flushed:          boolean  (true once sessionEnd has been written)
//   } | null
// }
//
// chrome.storage.session is cleared automatically when all Chrome windows close,
// which is exactly when a session ends organically.
// ─────────────────────────────────────────────────────────────────
async function sessionGet() {
  const { activeSession = null } = await chrome.storage.session.get('activeSession');
  return activeSession;
}

async function sessionSet(s) {
  await chrome.storage.session.set({ activeSession: s });
}

async function sessionClear() {
  await chrome.storage.session.remove('activeSession');
}

// 6.1: Called at the start of every successful capture.
// Returns { isFirstInSession, sessionStart } for inclusion in the upload body.
async function sessionOnCapture(projectId, capturePath) {
  let s = await sessionGet();
  const now = new Date().toISOString();

  if (!s || s.projectId !== projectId || s.flushed) {
    // Start a new session
    s = {
      sessionId:        crypto.randomUUID(),
      projectId,
      sessionStart:     now,
      totalCaptures:    1,
      firstCapturePath: capturePath,
      lastCapturePath:  capturePath,
      flushed:          false
    };
    await sessionSet(s);
    console.log('[Hammer SW] new session started | id:', s.sessionId);
    return { isFirstInSession: true, sessionStart: s.sessionStart, sessionId: s.sessionId };
  }

  // Continue existing session
  s.totalCaptures++;
  s.lastCapturePath = capturePath;
  await sessionSet(s);
  return { isFirstInSession: false, sessionStart: s.sessionStart, sessionId: s.sessionId };
}

// 6.2 / 6.3: Write session_events doc to backend. Idempotent via flushed flag.
async function sessionFlush(reason) {
  const s = await sessionGet();
  if (!s || s.flushed) return;

  const { settings } = await chrome.storage.local.get('settings');
  const cloudRunUrl = settings?.cloudRunUrl?.trim() || FALLBACK_API_BASE;
  const apiKey      = settings?.apiKey?.trim() || '';
  if (!apiKey) return;

  const now = new Date().toISOString();

  // 6.3: deleteAfter = sessionStart + 365 days
  const deleteAfter = new Date(
    new Date(s.sessionStart).getTime() + 365 * 24 * 60 * 60 * 1000
  ).toISOString();

  const body = {
    sessionId:        s.sessionId,
    projectId:        s.projectId,
    // userId resolved server-side from X-Api-Key (5.15)
    sessionStart:     s.sessionStart,
    sessionEnd:       now,
    totalCaptures:    s.totalCaptures,
    firstCapturePath: s.firstCapturePath,
    lastCapturePath:  s.lastCapturePath,
    schemaVersion:    1,
    deleteAfter,
    flushReason:      reason   // 'suspend' | 'window_removed' — diagnostic only
  };

  // Mark flushed BEFORE the network call to prevent a race between the two
  // flush triggers both attempting to write simultaneously.
  s.flushed = true;
  await sessionSet(s);

  try {
    const res = await fetch(`${cloudRunUrl}/session-events`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body:    JSON.stringify(body),
      // keepalive: true allows the fetch to outlive the SW suspension window
      keepalive: true
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log('[Hammer SW] session_events written ✓ | id:', s.sessionId, '| reason:', reason);
  } catch (err) {
    console.error('[Hammer SW] session_events write failed:', err.message,
                  '| session:', s.sessionId);
    // Un-mark flushed so the other flush trigger can retry
    s.flushed = false;
    await sessionSet(s);
  }
}

// ─────────────────────────────────────────────────────────────────
// 6.2 — Double-flush listeners
// ─────────────────────────────────────────────────────────────────

// (a) SW about to be suspended
chrome.runtime.onSuspend.addListener(() => {
  console.log('[Hammer SW] onSuspend — flushing session');
  sessionFlush('suspend');
});

// (b) A Chrome window was closed; flush if no windows remain
chrome.windows.onRemoved.addListener(async () => {
  const windows = await chrome.windows.getAll();
  if (windows.length === 0) {
    console.log('[Hammer SW] last window closed — flushing session');
    await sessionFlush('window_removed');
    await sessionClear();
  }
});

// ─────────────────────────────────────────────────────────────────
// 4.1 — Offline queue helpers
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
// 4.5 — History helpers (max 20 entries)
// ─────────────────────────────────────────────────────────────────
async function historyAppend(entry) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift(entry);
  if (history.length > 20) history.pop();
  await chrome.storage.local.set({ history });
}

// ─────────────────────────────────────────────────────────────────
// 4.2 — Retry with exponential backoff
// ─────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRY_DELAYS_MS = [1000, 2000, 4000];

async function withRetry(uploadFn) {
  let lastErr;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await uploadFn();
    } catch (err) {
      lastErr = err;
      console.warn(`[Hammer SW] attempt ${attempt + 1} failed:`, err.message);
      if (attempt < RETRY_DELAYS_MS.length - 1) {
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
// Drain offline queue on every SW startup
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
})();

// ── Install: inject content.js into already-open tabs ──
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (e) { /* restricted page — ignore */ }
  }
  console.log('[Hammer SW] installed; injected content.js into', tabs.length, 'tabs');
});

// ── Keyboard shortcut ──
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-screenshot') return;
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
      if (result === null)          sendResponse({ ok: false, reason: 'blocked' });
      else if (result.reason)       sendResponse({ ok: false, reason: result.reason });
      else                          sendResponse({ ok: true, path: result.path });
    })
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true;
});

// ─────────────────────────────────────────────────────────────────
// capture(tab) — shared by all three triggers
// 6.1: calls sessionOnCapture() after a successful upload to log
//      sessionStart / isFirstInSession on the uploads doc via the upload body.
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

  const { settings } = await chrome.storage.local.get('settings');
  const cloudRunUrl = settings?.cloudRunUrl?.trim() || FALLBACK_API_BASE;
  const apiKey      = settings?.apiKey?.trim() || '';

  if (!apiKey) {
    console.warn('[Hammer SW] capture blocked: no API key');
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
    await showNotification('Capture failed', 'Screenshot data looks invalid. Try again.');
    return null;
  }

  const blob = await fetch(dataUrl).then((r) => r.blob());
  if (!(blob instanceof Blob) || blob.type !== 'image/png' || blob.size === 0) {
    await showNotification('Capture failed', 'Could not convert screenshot to PNG blob.');
    return null;
  }

  console.log('[Hammer SW] captured PNG ✓ | size:', blob.size, '| project:', session.projectId);

  // 6.1: Determine session context BEFORE upload so we can include
  //      isFirstInSession + sessionStart in the upload-url request body.
  //      We use a temporary path placeholder; we'll update lastCapturePath
  //      after we know the real GCS path.
  const prePath = `pending/${session.projectId}/${Date.now()}`;
  const sessionCtx = await sessionOnCapture(session.projectId, prePath);

  let uploadResult;
  try {
    uploadResult = await withRetry(() =>
      uploadBlobWithSignedUrl(blob, session, tab.url, cloudRunUrl, apiKey, sessionCtx)
    );
  } catch (uploadErr) {
    console.error('[Hammer SW] all retries failed, queuing:', uploadErr.message);
    const base64 = await blobToBase64(blob);
    await queueAdd(base64, session, tab.url);
    await showNotification('Upload queued', 'No connection — will retry when online.');
    return null;
  }

  // Update session state with the real GCS path
  const s = await sessionGet();
  if (s && !s.flushed) {
    if (s.firstCapturePath === prePath) s.firstCapturePath = uploadResult.path;
    s.lastCapturePath = uploadResult.path;
    await sessionSet(s);
  }

  await historyAppend({
    path:      uploadResult.path,
    size:      blob.size,
    ts:        Date.now(),
    projectId: session.projectId,
    tool:      session.tool ?? ''
  });

  await showNotification('Screenshot uploaded ✓', uploadResult.path || 'Saved to GCS');
  console.log('[Hammer SW] upload ✓ | path:', uploadResult.path,
              '| isFirst:', sessionCtx.isFirstInSession);
  return uploadResult;
}

// ─────────────────────────────────────────────────────────────────
// uploadBlobWithSignedUrl
// 6.1: sessionCtx { isFirstInSession, sessionStart, sessionId } added to body
//      so the backend can stamp the uploads doc correctly.
// 5.15: userId removed from body.
// ─────────────────────────────────────────────────────────────────
async function uploadBlobWithSignedUrl(blob, session, tabUrl, cloudRunUrl, apiKey, sessionCtx = {}) {
  const controller1 = new AbortController();
  const t1 = setTimeout(() => controller1.abort(), 15_000);
  let signedUrlResponse;
  try {
    const res = await fetch(`${cloudRunUrl}/upload-url`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body:    JSON.stringify({
        project:           session.projectId,
        tool:              session.tool  ?? '',
        stage:             session.stage ?? '',
        // 6.1 — session fields for backend to stamp on the uploads doc
        isFirstInSession:  sessionCtx.isFirstInSession  ?? false,
        sessionStart:      sessionCtx.sessionStart       ?? null,
        sessionId:         sessionCtx.sessionId          ?? null
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
    return uploadViaProxy(blob, session, tabUrl, cloudRunUrl, apiKey, sessionCtx);
  }

  try {
    await xhrPut(signedUrlResponse.signedUrl, blob);
  } catch (err) {
    console.warn('[Hammer SW] XHR PUT failed, using proxy:', err.message);
    return uploadViaProxy(blob, session, tabUrl, cloudRunUrl, apiKey, sessionCtx);
  }

  return { path: signedUrlResponse.path };
}

// ─────────────────────────────────────────────────────────────────
// uploadViaProxy — /capture fallback path
// 6.1: sessionCtx fields added to FormData.
// 5.15: userId removed.
// ─────────────────────────────────────────────────────────────────
async function uploadViaProxy(blob, session, tabUrl, cloudRunUrl, apiKey, sessionCtx = {}) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 15_000);

  const formData = new FormData();
  formData.append('file',               blob, 'screenshot.png');
  formData.append('projectId',          session.projectId);
  formData.append('tool',               session.tool  ?? '');
  formData.append('stage',              session.stage ?? '');
  formData.append('tabUrl',             tabUrl ?? '');
  formData.append('isFirstInSession',   String(sessionCtx.isFirstInSession ?? false));
  formData.append('sessionStart',       sessionCtx.sessionStart ?? '');
  formData.append('sessionId',          sessionCtx.sessionId    ?? '');

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
    return await response.json();
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
      type: 'basic', iconUrl: ICON_DATA_URI, title, message
    }, resolve);
  });
}
