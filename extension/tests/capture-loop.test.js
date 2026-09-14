'use strict';

// #6 — the capture loop: the offline queue, the backoff retry, and the failed
// list that holds a Capture the retries could not deliver.
//
// AGENTS.md rule 4 makes a lost Capture non-negotiable, so every case here ends
// by accounting for the Capture: it was delivered, it is queued, or it is on the
// failed list. None of them may simply be gone.
//
// The retry waits are real setTimeouts inside the worker. node:test's mock
// timers replace setTimeout in this realm, and sw-harness's sandbox calls
// through to it, so a test can step the clock a millisecond at a time instead
// of sleeping out the backoff. Enable them before booting the worker: the
// sandbox captures clearTimeout when it is built.
//
// The CAP numbers are this file's own. No test plan defining them survived, so
// each one is named for the behaviour #6 asks to be proven.
//
// Every case here passed on arrival, because the behaviour already existed.
// Each was then shown to go red against a deliberately broken worker: a changed
// backoff delay, a fourth attempt, a sleep after the last attempt, no retry, a
// capture that drops instead of queueing, a drain that drops failures, keeps
// delivered items, or delivers newest first (lesson 44).
//
// Run with: npm run test:extension

const test = require('node:test');
const assert = require('node:assert');
const { loadServiceWorker } = require('./sw-harness.js');

const TAB = { id: 1, windowId: 10, url: 'https://softomedia.test/campaigns', title: 'Campaigns' };

const READY = {
  settings: { cloudRunUrl: 'https://api.test/api', firebaseToken: 'test-token' },
  session: { projectId: 'proj-a', stage: 'media-buyer', tool: 'Softomedia' }
};

// The harness turns every captured screenshot into this Blob.
const CAPTURED_BYTES = 'png';

const isUploadUrl = (url) => String(url).endsWith('/upload-url');
const isProxy     = (url) => String(url).endsWith('/capture');

// What a dead network looks like from inside a service worker: fetch rejects.
// Not a 401, which withRetry deliberately refuses to retry (#39).
const networkDown = async () => { throw new TypeError('Failed to fetch'); };

// A working backend, for tests that supply their own fetch and so lose the
// harness default.
async function backendUp(url) {
  if (isUploadUrl(url)) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ signedUrl: 'https://gcs.test/signed-put', readUrl: 'https://gcs.test/read', path: 'uploads/test.png' })
    };
  }
  if (isProxy(url)) return { ok: true, status: 200, json: async () => ({ path: 'uploads/proxy.png' }) };
  return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
}

// One upload attempt starts with /upload-url and, when that fails, falls back
// to the proxy. Counting /upload-url counts attempts.
const uploadUrlRequests = (sw) => sw.requests.filter((r) => isUploadUrl(r.url));
const attempts = (sw) => uploadUrlRequests(sw).length;

// The shape queueAdd() writes.
function queuedItem(projectId) {
  return {
    blobBase64: Buffer.from(CAPTURED_BYTES).toString('base64'),
    session: { ...READY.session, projectId },
    tabUrl: TAB.url,
    semanticData: null,
    ts: 1_700_000_000_000,
    attempts: 0
  };
}

function boot(opts) {
  return loadServiceWorker({ local: READY, tabs: [TAB], ...opts });
}

/** Move the mocked clock, then let the worker run whatever that released. */
async function advance(t, sw, ms) {
  t.mock.timers.tick(ms);
  await sw.settle();
}

/**
 * Run a fresh upload through every retry the worker will give it: the first
 * attempt, then the 1s and 2s waits (CAP-03 pins those figures).
 */
async function exhaustRetries(t, sw) {
  await sw.settle();
  await advance(t, sw, 1000);
  await advance(t, sw, 2000);
}

/** Track a promise's settlement without awaiting it. */
function trackSettlement(promise) {
  const state = { done: false, value: undefined };
  promise.then((value) => { state.done = true; state.value = value; });
  return state;
}

// ── Queueing while offline ──────────────────────────────────────────────────

test('CAP-02: a Capture taken offline is queued with everything needed to replay it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sw = boot({ fetch: networkDown });

  const reply = trackSettlement(sw.send({ type: 'CAPTURE' }));
  await exhaustRetries(t, sw);

  assert.ok(reply.done, 'the Capture must settle once its retries are spent');
  assert.strictEqual(reply.value.reason, 'queued');

  const { queue = [], failed = [], history = [] } = sw.local._peek();
  assert.strictEqual(queue.length, 1, 'the Capture must be kept, not dropped');
  assert.deepStrictEqual(failed, [], 'a live Capture that failed goes to the queue, not straight to failed');
  assert.deepStrictEqual(history, [], 'nothing was delivered, so nothing may be recorded as uploaded');

  const [item] = queue;
  assert.strictEqual(Buffer.from(item.blobBase64, 'base64').toString(), CAPTURED_BYTES,
    'the queued bytes must be the screenshot itself');
  assert.deepStrictEqual(item.session, READY.session);
  assert.strictEqual(item.tabUrl, TAB.url);
  assert.strictEqual(item.attempts, 0);

  assert.ok(sw.notifications.some((n) => n.title === 'Upload queued'),
    'the person is told the Capture was kept for later');
});

// ── The backoff schedule and its ceiling ────────────────────────────────────

test('CAP-03: a failed upload is retried after 1s, then after 2s more', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sw = boot({ fetch: networkDown });

  sw.send({ type: 'CAPTURE' });
  await sw.settle();
  assert.strictEqual(attempts(sw), 1, 'the first attempt is immediate');

  await advance(t, sw, 999);
  assert.strictEqual(attempts(sw), 1, 'no retry before 1s');
  await advance(t, sw, 1);
  assert.strictEqual(attempts(sw), 2, 'the second attempt comes at 1s');

  await advance(t, sw, 1999);
  assert.strictEqual(attempts(sw), 2, 'no retry before a further 2s');
  await advance(t, sw, 1);
  assert.strictEqual(attempts(sw), 3, 'the third attempt comes 2s after the second');
});

test('CAP-04: the retry stops at three attempts, and gives up without waiting again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sw = boot({ fetch: networkDown });

  const reply = trackSettlement(sw.send({ type: 'CAPTURE' }));
  await exhaustRetries(t, sw);

  // withRetry sleeps only *between* attempts, so three attempts wait twice.
  assert.strictEqual(attempts(sw), 3);
  assert.ok(reply.done, 'after the third failure the Capture is queued at once, with no further wait');

  await advance(t, sw, 60_000);
  assert.strictEqual(attempts(sw), 3, 'there is no fourth attempt, however long the worker waits');
});

test('CAP-05: a Capture that succeeds on a retry is delivered, not queued', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let firstAttempt = true;
  const sw = boot({
    fetch: async (url) => {
      // Both halves of the first attempt fail; everything after it works.
      if (firstAttempt && isUploadUrl(url)) throw new TypeError('Failed to fetch');
      if (firstAttempt && isProxy(url)) { firstAttempt = false; throw new TypeError('Failed to fetch'); }
      return backendUp(url);
    }
  });

  const reply = trackSettlement(sw.send({ type: 'CAPTURE' }));
  await sw.settle();
  await advance(t, sw, 1000);

  assert.ok(reply.done);
  assert.strictEqual(attempts(sw), 2);
  assert.strictEqual(reply.value.ok, true);
  assert.strictEqual(reply.value.path, 'uploads/test.png');

  const { queue = [], history = [] } = sw.local._peek();
  assert.deepStrictEqual(queue, [], 'a delivered Capture must not also be queued');
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].path, 'uploads/test.png');
});

// ── Flushing on reconnect ───────────────────────────────────────────────────
//
// The worker has no connectivity listener. It drains the queue each time it
// starts, and Chrome starts it again soon after the network returns, so a
// restart with a working backend is what "reconnect" means here.

test('CAP-06: queued Captures are delivered in order when the worker restarts online', async () => {
  const sw = boot({ local: { ...READY, queue: [queuedItem('proj-first'), queuedItem('proj-second')] } });
  await sw.settle();

  const { queue = [], failed = [], history = [] } = sw.local._peek();
  assert.deepStrictEqual(queue, [], 'every delivered Capture leaves the queue');
  assert.deepStrictEqual(failed, []);

  const sent = uploadUrlRequests(sw).map((r) => r.body.project);
  assert.deepStrictEqual(sent, ['proj-first', 'proj-second'], 'the queue drains oldest first');

  // historyAppend puts the newest first.
  assert.deepStrictEqual(history.map((h) => h.projectId), ['proj-second', 'proj-first'],
    'each drained Capture is recorded as uploaded');
});

// ── The failed list ─────────────────────────────────────────────────────────

test('CAP-07: a queued Capture that exhausts its retries lands on the failed list intact', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const item = queuedItem('proj-a');
  const sw = boot({ local: { ...READY, queue: [item] }, fetch: networkDown });

  await exhaustRetries(t, sw);

  assert.strictEqual(attempts(sw), 3, 'the drain gives a queued Capture the same three attempts');

  const { queue = [], failed = [] } = sw.local._peek();
  assert.deepStrictEqual(queue, [], 'the item has left the queue');
  assert.strictEqual(failed.length, 1, 'and is on the failed list rather than gone');

  const [entry] = failed;
  assert.strictEqual(entry.blobBase64, item.blobBase64, 'the screenshot bytes are still held');
  assert.deepStrictEqual(entry.session, item.session);
  assert.strictEqual(entry.tabUrl, item.tabUrl);
  assert.strictEqual(typeof entry.failedAt, 'number');
  assert.match(entry.error, /Failed to fetch/, 'the failure is recorded with its cause');
});

test('CAP-08: a drain where some Captures fail loses none of them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sw = boot({
    local: { ...READY, queue: [queuedItem('proj-good'), queuedItem('proj-bad')] },
    fetch: async (url, init) => {
      const project = isUploadUrl(url) ? JSON.parse(init.body).project
        : isProxy(url) ? init.body.get('projectId')
        : null;
      if (project === 'proj-bad') throw new TypeError('Failed to fetch');
      return backendUp(url);
    }
  });

  await exhaustRetries(t, sw);

  const { queue = [], failed = [], history = [] } = sw.local._peek();
  assert.deepStrictEqual(queue, []);
  assert.deepStrictEqual(history.map((h) => h.projectId), ['proj-good'], 'the healthy Capture was delivered');
  assert.deepStrictEqual(failed.map((f) => f.session.projectId), ['proj-bad'], 'the failing one was kept');
  assert.strictEqual(history.length + failed.length, 2, 'every queued Capture is accounted for');
});
