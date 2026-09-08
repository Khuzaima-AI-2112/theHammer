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
//   — userId guard removed; identity resolved server-side from the Firebase ID token.
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
// reason values, one per refusal capture() can return (#72 — these used to all
// collapse onto a bare `null`, which every caller mapped to 'blocked' and
// popup.js rendered as "set Project & save first" even when that was false):
//   'no_project' | 'restricted_page' | 'invalid_screenshot' |
//   'blob_conversion_failed' | 'cancelled' | 'queued' | 'no_api_key' | 'unauthorized'

// #39: refreshFirebaseToken()/authedFetch() live in auth.js because the popup
// needs them too and the extension has no bundler. importScripts is synchronous
// and runs before any listener fires, so the globals are always in place.
importScripts('auth.js');

const ICON_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
  'AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// #26: no `/api` prefix. The backend mounts every route the extension calls at
// the root — `app.use('/', require('./routes/admin/me'))` in backend/src/index.js
// — so /api/config, /api/upload-url and /api/session-events are all 404.
const FALLBACK_API_BASE = 'https://thehammer-backend-282689937365.northamerica-northeast1.run.app';

// ─────────────────────────────────────────────────────────────────
// #26 — apiBase(settings)
//
// Every call site used to read `settings.cloudRunUrl` raw and fall back to the
// constant. A profile that cached the old prefixed URL keeps 404ing after the
// constant is fixed, so the value is normalised where it is read as well as
// being cleaned in storage below. Stripping is idempotent and safe to repeat.
// ─────────────────────────────────────────────────────────────────
function normaliseApiBase(url) {
  return String(url ?? '')
    .trim()
    .replace(/\/+$/, '')     // trailing slashes
    .replace(/\/api$/, '');  // the prefix that never existed on the backend
}

function apiBase(settings) {
  return normaliseApiBase(settings?.cloudRunUrl) || FALLBACK_API_BASE;
}

// One-time cleanup of a cached bad URL, so the Settings panel and anything
// reading storage directly stop showing a URL that cannot work. Reads are
// normalised anyway, so nothing depends on this having run.
(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  const stored = settings?.cloudRunUrl;
  if (!stored) return;
  const cleaned = normaliseApiBase(stored);
  if (cleaned === stored.trim()) return;
  await chrome.storage.local.set({ settings: { ...settings, cloudRunUrl: cleaned } });
  console.log('[Hammer SW] #26 cleaned cached API base:', stored, '->', cleaned);
})();

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
//
// ADR-0007: changing project ends the Session, but the change only becomes a
// boundary once a capture lands against the new project. This function is the
// only writer of Session state, so a project switched away from and back with
// nothing captured in between never reaches here and leaves the Session intact
// — which is the behaviour the Customer asked for, and it needs no timer.
async function sessionOnCapture(projectId, capturePath) {
  let s = await sessionGet();
  const now = new Date().toISOString();

  let boundaryCommitted = false;
  if (s && !s.flushed && s.projectId !== projectId) {
    // The boundary has just committed. Write the outgoing Session down before
    // it is replaced — overwriting it in place is what used to make an hour of
    // work vanish from the reports.
    boundaryCommitted = true;
    const written = await sessionFlush('project_changed');
    if (!written) {
      // Unlike 'suspend' and 'window_removed' there is no second trigger to
      // retry from: the state a retry would read is about to be overwritten.
      // Since #22 the body is queued instead of lost, and the drain replays it
      // at the next startup — so this is a delay to report, not a hole.
      console.warn('[Hammer SW] outgoing session could not be written at a project boundary; queued for retry',
                   '| id:', s.sessionId, '| project:', s.projectId);
    }
    s = null;
  }

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
    await sessionIndicate(s, boundaryCommitted);
    return { isFirstInSession: true, sessionStart: s.sessionStart, sessionId: s.sessionId };
  }

  // Continue existing session
  s.totalCaptures++;
  s.lastCapturePath = capturePath;
  await sessionSet(s);
  await sessionIndicate(s, false);
  return { isFirstInSession: false, sessionStart: s.sessionStart, sessionId: s.sessionId };
}

// ADR-0007: the Customer asked that a person be able to tell when switching
// project has started a new Session. The badge says so at the moment the
// boundary commits — not when the project changed, which may yet come to
// nothing — and clears itself on the following capture.
async function sessionIndicate(s, boundaryCommitted) {
  if (!chrome.action?.setBadgeText) return;
  try {
    await chrome.action.setTitle({
      title: boundaryCommitted
        ? `The Hammer — new session started for ${s.projectId}`
        : `The Hammer — session running on ${s.projectId} (${s.totalCaptures})`
    });
    await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
    await chrome.action.setBadgeText({ text: boundaryCommitted ? 'NEW' : '' });
  } catch (err) {
    // Rule 4: the capture loop is sacred. A badge that will not paint is not a
    // reason to lose a screenshot.
    console.warn('[Hammer SW] could not update the action badge:', err.message);
  }
}

// 6.2 / 6.3: Write session_events doc to backend. Idempotent via flushed flag.
// Returns true only when a session_events document reached the backend, so a
// caller that is about to discard the Session can tell that it was recorded.
// The one place that knows how to send a session_events body, so the live
// flush and the drain cannot drift apart — `keepalive` is the difference, and
// it belongs only to the flush, which may be racing service-worker suspension.
function postSessionEvents(cloudRunUrl, body, extra = {}) {
  return authedFetch(`${cloudRunUrl}/session-events`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    ...extra
  });
}

async function sessionFlush(reason) {
  const s = await sessionGet();
  if (!s || s.flushed) return false;

  const { settings } = await chrome.storage.local.get('settings');
  const cloudRunUrl = apiBase(settings);
  const token       = settings?.firebaseToken?.trim() || '';
  if (!token) return false;

  const now = new Date().toISOString();

  // 6.3: deleteAfter = sessionStart + 365 days
  const deleteAfter = new Date(
    new Date(s.sessionStart).getTime() + 365 * 24 * 60 * 60 * 1000
  ).toISOString();

  const body = {
    sessionId:        s.sessionId,
    projectId:        s.projectId,
    // userId resolved server-side from the Firebase ID token (5.15)
    sessionStart:     s.sessionStart,
    sessionEnd:       now,
    totalCaptures:    s.totalCaptures,
    firstCapturePath: s.firstCapturePath,
    lastCapturePath:  s.lastCapturePath,
    schemaVersion:    1,
    deleteAfter,
    flushReason:      reason   // 'suspend' | 'window_removed' | 'project_changed' — diagnostic only
  };

  // Mark flushed BEFORE the network call to prevent a race between the two
  // flush triggers both attempting to write simultaneously.
  s.flushed = true;
  await sessionSet(s);

  try {
    // keepalive: true allows the fetch to outlive the SW suspension window
    const res = await postSessionEvents(cloudRunUrl, body, { keepalive: true });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log('[Hammer SW] session_events written ✓ | id:', s.sessionId, '| reason:', reason);
    // This Session is recorded, so drop any earlier queued attempt at it (#22).
    // The backend merges on sessionId, so replaying a stale body afterwards
    // would push sessionEnd backwards over the document just written.
    await sessionQueueRemove(s.sessionId);
    return true;
  } catch (err) {
    console.error('[Hammer SW] session_events write failed:', err.message,
                  '| session:', s.sessionId);
    // #22: keep the body. Un-marking `flushed` below only helps the triggers
    // that get a second shot at the same state; at a project boundary the
    // Session is discarded immediately after this returns, and before this its
    // time was simply lost. The queue is local, so this does not hold up the
    // capture that crossed the boundary (rule 4).
    await sessionQueueAdd(body);
    // Un-mark flushed so the other flush trigger can retry
    s.flushed = false;
    await sessionSet(s);
    return false;
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

async function queueAdd(blobBase64, session, tabUrl, semanticData = null) {
  const { queue, failed } = await queueGet();
  queue.push({ blobBase64, session, tabUrl, semanticData, ts: Date.now(), attempts: 0 });
  await queueSave(queue, failed);
  console.log('[Hammer SW] queued offline item; queue length:', queue.length);
}

// ─────────────────────────────────────────────────────────────────
// 4.1b — Offline queue for Session events (#22)
//
// sessionFlush() un-marks `flushed` on failure so the other trigger can retry.
// That covers 'suspend' and 'window_removed', which are two shots at the same
// state. It cannot cover 'project_changed': the state a retry would read is
// replaced by the new Session microseconds later, so a project switch made
// offline used to lose the outgoing Session's time outright.
//
// The body is kept here instead, and replayed by the drain at startup — the
// same shape as the Capture queue above, on the same trigger. Replay is safe
// because the backend writes session_events with set(doc(sessionId), { merge:
// true }): the same body sent twice is one document, not two.
// ─────────────────────────────────────────────────────────────────
const SESSION_QUEUE_KEY = 'sessionQueue';

// A Session document is small, but a person offline for a week should not fill
// their profile with them. Oldest are dropped first: the newest Session is the
// one most likely to still matter to whoever is looking.
const SESSION_QUEUE_MAX = 50;

async function sessionQueueGet() {
  const { [SESSION_QUEUE_KEY]: q = [] } = await chrome.storage.local.get(SESSION_QUEUE_KEY);
  return q;
}

// The only writer, so the cap is enforced in one place rather than at each
// call site — including the drain, which writes back what it could not send.
async function sessionQueueSave(q) {
  await chrome.storage.local.set({ [SESSION_QUEUE_KEY]: q.slice(-SESSION_QUEUE_MAX) });
}

// Keyed by sessionId: a Session that fails twice is one queued body, not two,
// and the newer attempt wins because it carries the later sessionEnd.
async function sessionQueueAdd(body) {
  const q = (await sessionQueueGet()).filter((e) => e.body?.sessionId !== body.sessionId);
  q.push({ body, queuedAt: Date.now() });
  await sessionQueueSave(q);
  console.log('[Hammer SW] session_events queued for retry | id:', body.sessionId,
              '| queue length:', Math.min(q.length, SESSION_QUEUE_MAX));
}

// Called when a flush succeeds, so a stale queued copy cannot be replayed over
// a newer document. The backend merges on sessionId, so replaying an older
// body would push sessionEnd backwards.
async function sessionQueueRemove(sessionId) {
  const q = await sessionQueueGet();
  const remaining = q.filter((e) => e.body?.sessionId !== sessionId);
  if (remaining.length !== q.length) await sessionQueueSave(remaining);
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
      // #39: a 401 has already survived one refresh inside authedFetch, so the
      // refresh token is revoked or expired. Three more attempts over seven
      // seconds cannot change that, and they end on a message about the
      // network. Give up at once and let the caller say "sign in".
      if (isAuthExpired(err)) throw err;
      console.warn(`[Hammer SW] attempt ${attempt + 1} failed:`, err.message);
      if (attempt < RETRY_DELAYS_MS.length - 1) {
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────
// 4.3 — PUT the bytes straight to Cloud Storage
//
// #70: this was an XMLHttpRequest, for its upload progress events. A Manifest
// V3 service worker has no XMLHttpRequest — the worker global scope offers
// fetch and nothing else — so it threw ReferenceError on its first statement
// on every Capture, and the catch at the call site turned that into a silent
// proxy fallback. Every screenshot went through Cloud Run; not one signed-URL
// PUT ever ran.
//
// The cost of fetch is real and accepted: it cannot report upload progress, so
// the popup's bar is coarse here — 0 when the PUT starts, 100 when it lands.
// Continuous progress on this path has never actually worked, so nothing is
// lost that anyone has seen.
// ─────────────────────────────────────────────────────────────────
function reportUploadProgress(percent) {
  chrome.runtime.sendMessage({ type: 'UPLOAD_PROGRESS', percent }).catch(() => {});
}

async function putBlob(url, blob) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 30_000);

  reportUploadProgress(0);
  try {
    const res = await fetch(url, {
      method:  'PUT',
      headers: { 'Content-Type': 'image/png' },
      body:    blob,
      signal:  controller.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => String(res.status));
      throw new Error(`GCS PUT HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    reportUploadProgress(100);
    return res.status;
  } catch (err) {
    // An abort is this function's own 30s timeout, not a network fault. Say so,
    // rather than reporting the browser's generic "aborted without reason".
    if (err.name === 'AbortError') throw new Error('PUT timed out after 30s');
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─────────────────────────────────────────────────────────────────
// Drain offline queue on every SW startup
// ─────────────────────────────────────────────────────────────────
(async () => {
  const { queue, failed } = await queueGet();
  if (queue.length === 0) return;

  const { settings } = await chrome.storage.local.get('settings');
  const cloudRunUrl = apiBase(settings);
  const token       = settings?.firebaseToken?.trim() || '';
  if (!cloudRunUrl || !token) return;

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
        uploadBlobWithSignedUrl(blob, item.session, item.tabUrl, cloudRunUrl, token, {}, item.semanticData)
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

// ─────────────────────────────────────────────────────────────────
// Drain queued Session events on every SW startup (#22)
// ─────────────────────────────────────────────────────────────────
//
// Its own block rather than part of the Capture drain above, which returns
// early when there are no Captures waiting — a Session queued at a project
// boundary usually has no Capture queued beside it, so sharing that early
// return would mean the Session never replayed.
//
// Nothing here is retried in-process: a startup is the retry. withRetry's
// backoff exists to get a screenshot through before the worker is suspended,
// and a Session document that waited an hour can wait for the next startup.
(async () => {
  const pending = await sessionQueueGet();
  if (pending.length === 0) return;

  const { settings } = await chrome.storage.local.get('settings');
  const cloudRunUrl = apiBase(settings);
  const token       = settings?.firebaseToken?.trim() || '';
  // Signed out: keep them. Sending unauthenticated would fail anyway, and
  // dropping them here would lose exactly what this queue exists to hold.
  if (!cloudRunUrl || !token) return;

  console.log('[Hammer SW] draining queued session events:', pending.length, 'item(s)');

  for (const entry of pending) {
    const id = entry.body?.sessionId;

    // Re-read rather than trusting the snapshot taken above. A live flush can
    // succeed while this loop is awaiting, and it removes its own Session from
    // the queue; sending the copy held in memory afterwards would merge an
    // older body over the newer document and walk sessionEnd backwards.
    const current = await sessionQueueGet();
    if (!current.some((e) => e.body?.sessionId === id)) continue;

    try {
      const res = await postSessionEvents(cloudRunUrl, entry.body);

      // #39: authedFetch has already spent the refresh token, so a 401 here
      // means revoked or expired. Nothing queued can be sent until somebody
      // signs in, and trying the rest only repeats the same answer. Stop, and
      // keep everything: signing back in recovers it at the next startup.
      if (res.status === 401) {
        console.warn('[Hammer SW] sign-in required before queued sessions can be written;',
                     current.length, 'still waiting');
        break;
      }

      // A permanent refusal will be refused again forever — a Project purged
      // out from under the Session (403) is the realistic case. Retrying it
      // every startup would keep a poisoned entry alive until the cap evicted
      // it, and hide the entries behind it. Drop it, loudly. 408 and 429 are
      // the retryable exceptions and fall through to the throw below.
      if (!res.ok && res.status >= 400 && res.status < 500
          && res.status !== 408 && res.status !== 429) {
        console.error('[Hammer SW] queued session refused permanently, discarding | id:', id,
                      '| status:', res.status, '| project:', entry.body?.projectId);
        await sessionQueueRemove(id);
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Removed one at a time, re-reading each time, so a Session queued by a
      // project boundary happening *during* this drain is not erased by a
      // write-back of the stale snapshot.
      await sessionQueueRemove(id);
      const waited = entry.queuedAt ? `${Math.round((Date.now() - entry.queuedAt) / 1000)}s` : 'unknown';
      console.log('[Hammer SW] drained queued session ✓ | id:', id, '| waited:', waited);
    } catch (err) {
      // Still unreachable. It stays queued for the next startup — a startup is
      // the retry, so there is no backoff here to get wrong.
      console.warn('[Hammer SW] queued session still cannot be written:', err.message, '| id:', id);
    }
  }
})();

// ── Install: inject content.js into already-open tabs & setup context menus ──
chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({
    id: 'capture-element',
    title: 'Hammer: Capture this element',
    contexts: ['all']
  });
  chrome.contextMenus.create({
    id: 'capture-fullpage',
    title: 'Hammer: Capture full page',
    contexts: ['all']
  });

  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (e) { /* restricted page — ignore */ }
  }
  console.log('[Hammer SW] installed; injected content.js into', tabs.length, 'tabs');
});

// ── Startup: Clear stale sessions on browser startup ──
chrome.runtime.onStartup.addListener(async () => {
  console.log('[Hammer SW] Browser started. Clearing any stale session memory.');
  await sessionClear();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'capture-element') {
    chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_ELEMENT' }, async (res) => {
      if (chrome.runtime.lastError) {
        console.warn('[Hammer SW] Context menu error:', chrome.runtime.lastError.message);
        await showNotification('Capture failed', 'Please refresh the page to use element capture.');
        return;
      }
      if (res?.ok && res.rect) {
        await capture(tab, res.rect, res.dpr);
      } else {
        await showNotification('Capture failed', 'Could not determine element coordinates.');
      }
    });
  } else if (info.menuItemId === 'capture-fullpage') {
    chrome.tabs.sendMessage(tab.id, { type: 'START_FULLPAGE_CAPTURE' }, async (res) => {
      if (chrome.runtime.lastError) {
        console.warn('[Hammer SW] Context menu error:', chrome.runtime.lastError.message);
        await showNotification('Capture failed', 'Please refresh the page to use full-page capture.');
        return;
      }
      if (res?.ok && res.dataUrl) {
        await capture(tab, null, 1, res.dataUrl);
      } else {
        await showNotification('Capture failed', res?.error || 'Unknown error during full-page capture.');
      }
    });
  }
});

// ── Keyboard shortcut ──
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-screenshot') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await capture(tab);
});

// ── Long-lived port from content script ──
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'capture-port') return;
  // We do not store the port globally; its existence alone keeps the worker alive
});

// ── Messages from popup and content script ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CAPTURE_TAB_PORTION') {
    if (!sender.tab) {
      sendResponse({ error: 'Sender is not a tab' });
      return false;
    }
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }).then(dataUrl => {
      sendResponse({ dataUrl });
    }).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'STITCH_IMAGES') {
    setupOffscreenDocument('offscreen.html').then(() => {
      chrome.runtime.sendMessage({
        type: 'STITCH_IMAGES_OFFSCREEN',
        parts: msg.parts,
        width: msg.width,
        height: msg.height
      }, sendResponse);
    });
    return true;
  }
  if (msg.type === 'CAPTURE_NOW') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      if (tabs.length > 0) await capture(tabs[0]);
      sendResponse({ status: 'ok' });
    });
    return true; // async
  }
  if (msg.type === 'SNOOZE_INACTIVITY') {
    chrome.alarms.clear('dismiss_inactivity_prompt');
    getInactivityTimerSeconds().then(sec => {
      chrome.alarms.create('inactivity_timer', { delayInMinutes: sec / 60 });
    });
    logInactivityEvent();
    sendResponse({ status: 'ok' });
    return true;
  }
  if (msg.type === 'CAPTURE_INACTIVITY') {
    chrome.alarms.clear('dismiss_inactivity_prompt');
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      if (tabs.length > 0) await capture(tabs[0]);
      logInactivityEvent();
      sendResponse({ status: 'ok' });
    });
    return true; // async
  }
  // ── #11: the two capture modes offered in the popup ──
  // ACT-01 is protected by omission: plain screenshot capture (the toolbar
  // popup's Capture Now, the floating button, Ctrl+Shift+S, the context menu)
  // is not routed through any of this.
  if (msg.type === 'CAPTURE_SNIP' || msg.type === 'CAPTURE_FULLPAGE') {
    const snip = msg.type === 'CAPTURE_SNIP';
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      const tab = tabs && tabs[0];
      if (!tab) {
        sendResponse({ ok: false, error: 'No active tab' });
        return;
      }
      const request = snip ? { type: 'SNIP_SELECT' } : { type: 'START_FULLPAGE_CAPTURE' };
      chrome.tabs.sendMessage(tab.id, request, async (res) => {
        // lastError must be read before the first await, or it is gone.
        const noContentScript = chrome.runtime.lastError;
        try {
          if (noContentScript) {
            // ACT-03: the content script is missing — a tab opened before the
            // extension was loaded, the Web Store, the PDF viewer. Fall back to
            // a plain visible-tab capture rather than refusing (AGENTS.md rule
            // 4). Genuinely restricted URLs still stop inside capture().
            console.warn('[Hammer SW] no content script, falling back to a full capture:',
                         noContentScript.message);
            sendResponse(captureReply(await capture(tab), { fellBack: true }));
            return;
          }
          if (res?.reason === 'cancelled') {
            // The person pressed Escape. Nothing to capture, nothing to say.
            sendResponse({ ok: false, reason: 'cancelled' });
            return;
          }
          if (snip) {
            if (!res?.ok || !res.rect) {
              sendResponse({ ok: false, error: res?.error || 'Could not determine the selected region' });
              return;
            }
            sendResponse(captureReply(await capture(tab, res.rect, res.dpr)));
          } else {
            if (!res?.ok || !res.dataUrl) {
              sendResponse({ ok: false, error: res?.error || 'Unknown error during full-page capture' });
              return;
            }
            sendResponse(captureReply(await capture(tab, null, 1, res.dataUrl)));
          }
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      });
    });
    return true; // async
  }
  if (msg.type !== 'CAPTURE') return false;
  if (sender.tab && sender.frameId !== 0) return false;

  const tabPromise = sender.tab
    ? Promise.resolve(sender.tab)
    : chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t);

  tabPromise
    .then((tab) => capture(tab))
    .then((result) => {
      // #72: capture() always returns { reason } or { path } now, never a bare
      // null — so there is exactly one value per refusal to map, not one for
      // all of them.
      if (result.reason)  sendResponse({ ok: false, reason: result.reason });
      else                 sendResponse({ ok: true, path: result.path });
    })
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true;
});

// ─────────────────────────────────────────────────────────────────
// captureReply — turn a capture() result into the popup's response shape.
// Mirrors the mapping the CAPTURE handler has always used; `extra` carries
// flags the caller wants alongside it, such as { fellBack: true } for ACT-03.
// ─────────────────────────────────────────────────────────────────
function captureReply(result, extra = {}) {
  if (result.reason)      return { ok: false, reason: result.reason, ...extra };
  return { ok: true, path: result.path, ...extra };
}

// ─────────────────────────────────────────────────────────────────
// capture(tab, rect, dpr) — shared by all three triggers
// 6.1: calls sessionOnCapture() after a successful upload to log
//      sessionStart / isFirstInSession on the uploads doc via the upload body.
// ─────────────────────────────────────────────────────────────────
async function capture(tab, rect = null, dpr = 1, preCapturedDataUrl = null) {
  if (!tab || !tab.url ||
      tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('about:')) {
    await showNotification('Cannot capture this page', 'Navigate to a normal web page first.');
    return { reason: 'restricted_page' };
  }

  const { settings } = await chrome.storage.local.get('settings');
  const cloudRunUrl = apiBase(settings);
  const token       = settings?.firebaseToken?.trim() || '';

  if (!token) {
    console.warn('[Hammer SW] capture blocked: no Firebase token');
    return { reason: 'unauthorized' };
  }

  const { session } = await chrome.storage.local.get('session');
  if (!session || !session.projectId) {
    await showNotification('Project not set',
      'Open the popup, select a Project and press Save before capturing.');
    return { reason: 'no_project' };
  }

  // 10.1: Context Engine Auto-tagging
  if (!session.tool && tab.url) {
    try {
      const urlObj = new URL(tab.url);
      const host = urlObj.hostname;
      const title = tab.title || '';
      
      if (host.includes('figma.com')) {
        session.tool = 'Figma';
      } else if (host.includes('jira.com') || host.includes('atlassian.net')) {
        session.tool = 'Jira';
        // Try to extract ticket ID like PROJ-123 from title
        const match = title.match(/\[?([A-Z]+-\d+)\]?/);
        if (match) {
          session.tool = `Jira (${match[1]})`;
        }
      } else if (host.includes('github.com')) {
        session.tool = 'GitHub';
      } else if (host.includes('docs.google.com')) {
        session.tool = 'Google Docs';
      } else if (host.includes('linear.app')) {
        session.tool = 'Linear';
        const match = title.match(/([A-Z]+-\d+)/);
        if (match) {
          session.tool = `Linear (${match[1]})`;
        }
      } else if (host.includes('notion.so')) {
        session.tool = 'Notion';
      }
    } catch (e) {
      console.warn('[Hammer SW] Auto-tagging URL parse failed:', e);
    }
  }

  // 10.5: Extract Semantic Data
  let semanticData = null;
  try {
    const res = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_SEMANTIC_DATA' }, resolve);
      // Timeout in case content script is missing or hanging
      setTimeout(() => resolve(null), 2000); 
    });
    if (res && res.data) semanticData = res.data;
  } catch (e) {
    console.warn('[Hammer SW] Semantic data extraction failed:', e.message);
  }

  let dataUrl = preCapturedDataUrl;
  if (!dataUrl) {
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (err) {
      await showNotification('Capture failed', err.message);
      throw err;
    }
  }

  if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length < 10000) {
    await showNotification('Capture failed', 'Screenshot data looks invalid. Try again.');
    return { reason: 'invalid_screenshot' };
  }

  // 10.2: Crop to element if rect provided
  if (rect) {
    try {
      await setupOffscreenDocument('offscreen.html');
      const res = await chrome.runtime.sendMessage({
        type: 'CROP_IMAGE',
        dataUrl,
        rect,
        dpr
      });
      if (res?.ok && res.dataUrl) {
        dataUrl = res.dataUrl;
      } else {
        console.warn('[Hammer SW] Element crop failed:', res?.error);
      }
    } catch (e) {
      console.warn('[Hammer SW] Could not communicate with offscreen doc for crop:', e.message);
    }
  }

  // 10.4: Pre-Upload Privacy Blur
  if (settings?.allowPreUploadBlur) {
    try {
      const blurRes = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: 'BLUR_SCREENSHOT', dataUrl }, resolve);
        setTimeout(() => resolve({ timeout: true }), 30000); 
      });
      if (blurRes && blurRes.dataUrl === null) {
        console.log('[Hammer SW] Capture cancelled by user during blur');
        return { reason: 'cancelled' };
      }
      if (blurRes && blurRes.dataUrl) {
        dataUrl = blurRes.dataUrl;
      }
    } catch (e) {
      console.warn('[Hammer SW] Privacy blur failed:', e.message);
    }
  }

  const blob = await fetch(dataUrl).then((r) => r.blob());
  if (!(blob instanceof Blob) || blob.type !== 'image/png' || blob.size === 0) {
    await showNotification('Capture failed', 'Could not convert screenshot to PNG blob.');
    return { reason: 'blob_conversion_failed' };
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
      uploadBlobWithSignedUrl(blob, session, tab.url, cloudRunUrl, token, sessionCtx, semanticData)
    );
  } catch (uploadErr) {
    console.error('[Hammer SW] upload failed, queuing:', uploadErr.message);
    // The capture is kept either way: AGENTS.md rule 4 says a screenshot must
    // never be lost because a backend feature is down. Only the reason we give
    // for keeping it differs.
    const base64 = await blobToBase64(blob);
    await queueAdd(base64, session, tab.url, semanticData);
    const notice = uploadFailureNotice(uploadErr);
    await showNotification(notice.title, notice.message);
    return { reason: 'queued' };
  }

  // Update session state with the real GCS path
  const s = await sessionGet();
  if (s && !s.flushed) {
    if (s.firstCapturePath === prePath) s.firstCapturePath = uploadResult.path;
    s.lastCapturePath = uploadResult.path;
    await sessionSet(s);
  }

  // 6.2/6.4: Set inactivity timer (resets any existing timer)
  const timerSec = await getInactivityTimerSeconds();
  chrome.alarms.create('inactivity_timer', { delayInMinutes: timerSec / 60 });

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
              
  if (settings?.instantClipboardLinks && uploadResult.readUrl) {
    try {
      await setupOffscreenDocument('offscreen.html');
      const res = await chrome.runtime.sendMessage({
        type: 'WRITE_CLIPBOARD',
        text: uploadResult.readUrl
      });
      if (res?.ok) {
        await showNotification('Link Copied', 'Screenshot link is in your clipboard.');
      } else {
        console.warn('[Hammer SW] Clipboard write failed:', res?.error);
      }
    } catch (e) {
      console.warn('[Hammer SW] Could not communicate with offscreen doc:', e.message);
    }
  }

  return uploadResult;
}

// ─────────────────────────────────────────────────────────────────
// Offscreen Document Helper
// ─────────────────────────────────────────────────────────────────
async function setupOffscreenDocument(path) {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: path,
    reasons: ['CLIPBOARD', 'DOM_PARSER'],
    justification: 'Write link to clipboard and crop images using canvas'
  });
}

// ─────────────────────────────────────────────────────────────────
// uploadBlobWithSignedUrl
// 6.1: sessionCtx { isFirstInSession, sessionStart, sessionId } added to body
//      so the backend can stamp the uploads doc correctly.
// 5.15: userId removed from body.
// ─────────────────────────────────────────────────────────────────
async function uploadBlobWithSignedUrl(blob, session, tabUrl, cloudRunUrl, token, sessionCtx = {}, semanticData = null) {
  const controller1 = new AbortController();
  const t1 = setTimeout(() => controller1.abort(), 15_000);
  let signedUrlResponse;
  try {
    const bodyObj = {
      project:           session.projectId,
      tool:              session.tool  ?? '',
      stage:             session.stage ?? '',
      // #66: this path records the Capture before the bytes are PUT, so the
      // backend never sees them and cannot learn these two for itself. The
      // proxy path has always sent both; sending them here is what makes the
      // two paths record the same thing.
      tabUrl:            tabUrl ?? '',
      size:              blob?.size ?? null,
      // 6.1 — session fields for backend to stamp on the uploads doc
      isFirstInSession:  sessionCtx.isFirstInSession  ?? false,
      sessionStart:      sessionCtx.sessionStart       ?? null,
      sessionId:         sessionCtx.sessionId          ?? null
    };
    if (semanticData) bodyObj.semanticData = semanticData;

    const res = await authedFetch(`${cloudRunUrl}/upload-url`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(bodyObj),
      signal: controller1.signal
    });
    clearTimeout(t1);
    if (!res.ok) {
      const text = await res.text().catch(() => res.status.toString());
      const err = new Error(`/upload-url HTTP ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;   // #39: lets withRetry spot a dead session
      throw err;
    }
    signedUrlResponse = await res.json();
  } catch (err) {
    clearTimeout(t1);
    console.warn('[Hammer SW] /upload-url failed, using proxy:', err.message);
    return uploadViaProxy(blob, session, tabUrl, cloudRunUrl, token, sessionCtx, semanticData);
  }

  try {
    await putBlob(signedUrlResponse.signedUrl, blob);
  } catch (err) {
    console.warn('[Hammer SW] PUT failed, using proxy:', err.message);
    // /upload-url has already recorded this Capture. Hand the proxy the path
    // it recorded, so the second write updates that document rather than
    // adding a twin whose bytes were never PUT.
    return uploadViaProxy(blob, session, tabUrl, cloudRunUrl, token, sessionCtx,
                          semanticData, signedUrlResponse.path);
  }

  return { path: signedUrlResponse.path, readUrl: signedUrlResponse.readUrl };
}

// ─────────────────────────────────────────────────────────────────
// uploadViaProxy — /capture fallback path
// 6.1: sessionCtx fields added to FormData.
// 5.15: userId removed.
// ─────────────────────────────────────────────────────────────────
async function uploadViaProxy(blob, session, tabUrl, cloudRunUrl, token, sessionCtx = {}, semanticData = null, resumePath = null) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 15_000);

  const formData = new FormData();
  formData.append('file',               blob, 'screenshot.png');
  formData.append('projectId',          session.projectId);
  formData.append('tool',               session.tool  ?? '');
  if (semanticData) {
    formData.append('semanticData', JSON.stringify(semanticData));
  }
  formData.append('stage',              session.stage ?? '');
  formData.append('tabUrl',             tabUrl ?? '');
  formData.append('isFirstInSession',   String(sessionCtx.isFirstInSession ?? false));
  formData.append('sessionStart',       sessionCtx.sessionStart ?? '');
  formData.append('sessionId',          sessionCtx.sessionId    ?? '');
  // Present only when /upload-url already recorded this Capture (see above).
  if (resumePath) formData.append('resumePath', resumePath);

  try {
    const response = await authedFetch(`${cloudRunUrl}/capture`, {
      method:  'POST',
      body:    formData,
      signal:  controller.signal
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const text = await response.text().catch(() => response.status.toString());
      const err = new Error(`/capture HTTP ${response.status} — ${text.slice(0, 200)}`);
      err.status = response.status;   // #39: lets withRetry spot a dead session
      throw err;
    }
    return await response.json();
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// ── Helpers ──
// #92, lessons_learned.md #65: FileReader.readAsDataURL yields a data URL,
// not base64 — strip the prefix so blobBase64 actually is what it's named.
async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ─────────────────────────────────────────────────────────────────
// Inactivity Alarms & Notifications (Sprint 6.2 & 6.4)
// ─────────────────────────────────────────────────────────────────

async function getInactivityTimerSeconds() {
  const { settings } = await chrome.storage.local.get('settings');
  return settings?.inactivityTimerSeconds || 45;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'dismiss_inactivity_prompt') {
    chrome.notifications.clear('inactivity_prompt');
    chrome.runtime.sendMessage({ type: 'DISMISS_INACTIVITY_PROMPT' }).catch(() => {});
    // Next inactivity cycle starts fresh
    const timerSec = await getInactivityTimerSeconds();
    chrome.alarms.create('inactivity_timer', { delayInMinutes: timerSec / 60 });
    return;
  }

  if (alarm.name !== 'inactivity_timer') return;

  const s = await sessionGet();
  // Only trigger if a session is actively running
  if (!s || s.flushed) return;

  const { settings } = await chrome.storage.local.get('settings');
  const cloudRunUrl = apiBase(settings);
  const token       = settings?.firebaseToken?.trim() || '';

  let enabled = false;
  if (token && cloudRunUrl) {
    try {
      const res = await authedFetch(`${cloudRunUrl}/config`, {
      });
      if (res.ok) {
        const data = await res.json();
        enabled = !!data.inactivityPromptEnabled;
      }
    } catch(err) {
      console.warn('[Hammer SW] failed to fetch config for inactivity alarm', err);
    }
  }

  if (!enabled) return;

  // URL Suppression check
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tabUrl = tabs[0]?.url || '';
  if (tabUrl.startsWith('chrome://') || tabUrl.startsWith('edge://') || tabUrl.startsWith('about:') || !tabUrl.startsWith('http')) {
    const timerSec = await getInactivityTimerSeconds();
    chrome.alarms.create('inactivity_timer', { delayInMinutes: timerSec / 60 });
    return;
  }

  let popupHandled = false;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'INACTIVITY_WARNING' });
    if (response && response.handled) {
      popupHandled = true;
    }
  } catch (err) {
    // Popup closed
  }

  if (!popupHandled) {
    chrome.notifications.create('inactivity_prompt', {
      type: 'basic',
      iconUrl: ICON_DATA_URI,
      title: 'Are you still there?',
      message: `It has been ${settings?.inactivityTimerSeconds || 45} seconds since your last capture. Would you like to capture now?`,
      buttons: [{ title: 'Capture Now' }, { title: 'Snooze' }],
      requireInteraction: true
    });
  }

  chrome.alarms.create('dismiss_inactivity_prompt', { delayInMinutes: 30 / 60 });
});

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (notificationId !== 'inactivity_prompt') return;
  chrome.notifications.clear(notificationId);
  chrome.alarms.clear('dismiss_inactivity_prompt');

  if (buttonIndex === 0) {
    // Capture Now
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      await capture(tabs[0]);
    }
  } else if (buttonIndex === 1) {
    // Snooze
    const timerSec = await getInactivityTimerSeconds();
    chrome.alarms.create('inactivity_timer', { delayInMinutes: timerSec / 60 });
  }

  // Always log the inactivity event
  await logInactivityEvent();
});

async function logInactivityEvent() {
  const s = await sessionGet();
  if (!s || s.flushed) return;

  const { settings } = await chrome.storage.local.get('settings');
  const cloudRunUrl = apiBase(settings);
  const token       = settings?.firebaseToken?.trim() || '';
  const timerSeconds = settings?.inactivityTimerSeconds || 45;

  if (token && cloudRunUrl) {
    const inactiveEnd = new Date().toISOString();
    // The start of inactivity was timerSeconds ago
    const inactiveStart = new Date(Date.now() - (timerSeconds * 1000)).toISOString();

    authedFetch(`${cloudRunUrl}/inactivity-events`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        eventId: crypto.randomUUID(),
        sessionId: s.sessionId,
        projectId: s.projectId,
        inactiveStart,
        inactiveEnd
      })
    }).catch(e => console.warn('[Hammer SW] failed to log inactivity', e));
  }
}

function showNotification(title, message) {
  return new Promise((resolve) => {
    chrome.notifications.create('', {
      type: 'basic', iconUrl: ICON_DATA_URI, title, message
    }, resolve);
  });
}
