'use strict';

// #22 — a session_events write that fails offline is kept, not lost.
//
// sessionFlush() had no retry beyond the fact that two lifecycle triggers both
// call it. On failure it un-marked `flushed` so the other trigger could try
// again, which works for 'suspend' and 'window_removed' — two shots at the same
// state. It does not work for 'project_changed', because the state a retry
// would read is overwritten by the new Session microseconds later. A project
// switch made offline therefore lost the outgoing Session's time for good, and
// offline is exactly when someone is likely to be working.
//
// Screenshots already had the answer: queueAdd()/queueGet() persist failed
// uploads and the startup drain replays them. This gives Session events the
// same treatment, on the same trigger.
//
// On AGENTS.md rule 4: sessionOnCapture already awaits sessionFlush at a
// project boundary, so the failing network call was on the capture path before
// this change. What is added is a chrome.storage.local write in the failure
// branch — local, and small beside the fetch that has just timed out. The claim
// worth making is the narrow one, and it is what the tests below assert: the
// new Session starts and the capture proceeds whether or not the outgoing
// Session could be sent.
//
// Run with: npm run test:extension

const test = require('node:test');
const assert = require('node:assert');
const { loadServiceWorker, sessionEvents } = require('./sw-harness.js');

const SETTINGS = {
  settings: { cloudRunUrl: 'https://api.test/api', firebaseToken: 'test-token' }
};

const boot = (opts = {}) => loadServiceWorker({ local: SETTINGS, ...opts });

/** Every /session-events attempt fails the way an offline machine fails. */
const offline = async (url) => {
  if (String(url).endsWith('/session-events')) throw new Error('Failed to fetch');
  return { ok: true, status: 200, json: async () => ({}) };
};

/** What is sitting in the queue right now. */
async function queued(sw) {
  const { sessionQueue = [] } = await sw.local.get('sessionQueue');
  return sessionQueue;
}

// ── The loss this issue is about ────────────────────────────────────────────

test('a session_events write that fails is persisted, not discarded', async () => {
  const sw = boot({ fetch: offline });

  await sw.sessionOnCapture('proj-a', 'a/1.png');
  const written = await sw.sessionFlush('project_changed');

  assert.strictEqual(written, false, 'the write did fail, so the test is exercising the failure path');

  const q = await queued(sw);
  assert.strictEqual(q.length, 1, 'the body should be waiting in the queue');
  assert.strictEqual(q[0].body.projectId, 'proj-a');
  assert.strictEqual(q[0].body.flushReason, 'project_changed');
  assert.strictEqual(q[0].body.firstCapturePath, 'a/1.png');
});

test('a project boundary while offline still starts the new Session immediately', async () => {
  const sw = boot({ fetch: offline });

  await sw.sessionOnCapture('proj-a', 'a/1.png');
  await sw.sessionOnCapture('proj-a', 'a/2.png');
  const b = await sw.sessionOnCapture('proj-b', 'b/1.png');

  // Rule 4: the capture that crossed the boundary is not held up by a Session
  // write that cannot complete.
  assert.strictEqual(b.isFirstInSession, true, 'the capture against proj-b opens its Session regardless');
  const current = await sw.sessionGet();
  assert.strictEqual(current.projectId, 'proj-b');
  assert.strictEqual(current.totalCaptures, 1);

  // And the outgoing Session's time survives, which it did not before.
  const q = await queued(sw);
  assert.strictEqual(q.length, 1);
  assert.strictEqual(q[0].body.projectId, 'proj-a');
  assert.strictEqual(q[0].body.totalCaptures, 2, 'it carries the outgoing project\'s captures, not the incoming one\'s');
  assert.strictEqual(q[0].body.lastCapturePath, 'a/2.png');
});

// ── The replay ──────────────────────────────────────────────────────────────

test('a queued Session is sent when connectivity returns, exactly once', async () => {
  const pending = [{
    body: {
      sessionId: 'sess-queued', projectId: 'proj-a', sessionStart: '2026-09-01T09:00:00.000Z',
      sessionEnd: '2026-09-01T09:30:00.000Z', totalCaptures: 2,
      firstCapturePath: 'a/1.png', lastCapturePath: 'a/2.png',
      schemaVersion: 1, deleteAfter: '2027-09-01T09:00:00.000Z', flushReason: 'project_changed'
    },
    queuedAt: Date.now()
  }];

  const sw = boot({ local: { ...SETTINGS, sessionQueue: pending } });
  await sw.settle();

  const events = sessionEvents(sw.requests);
  assert.strictEqual(events.length, 1, 'exactly one document, so a replay cannot double-count a Session');
  assert.strictEqual(events[0].sessionId, 'sess-queued');
  assert.strictEqual(events[0].projectId, 'proj-a', 'the document carries the outgoing project\'s fields');
  assert.strictEqual(events[0].totalCaptures, 2);

  assert.deepStrictEqual(await queued(sw), [], 'a sent Session is removed from the queue');
});

test('a queued Session that still cannot be sent stays queued', async () => {
  const pending = [{ body: { sessionId: 'sess-stuck', projectId: 'proj-a' }, queuedAt: Date.now() }];

  const sw = boot({ local: { ...SETTINGS, sessionQueue: pending }, fetch: offline });
  await sw.settle();

  const q = await queued(sw);
  assert.strictEqual(q.length, 1, 'still offline, so it waits for the next startup rather than being dropped');
  assert.strictEqual(q[0].body.sessionId, 'sess-stuck');
});

test('the drain does nothing without a token, rather than sending unauthenticated', async () => {
  const pending = [{ body: { sessionId: 'sess-anon', projectId: 'proj-a' }, queuedAt: Date.now() }];

  const sw = boot({
    local: { settings: { cloudRunUrl: 'https://api.test/api' }, sessionQueue: pending }
  });
  await sw.settle();

  assert.deepStrictEqual(sessionEvents(sw.requests), [], 'nothing is sent while signed out');
  assert.strictEqual((await queued(sw)).length, 1, 'and nothing is lost either — it waits for a sign-in');
});

// ── Keeping the queue honest ────────────────────────────────────────────────

test('re-queueing the same Session replaces it rather than duplicating it', async () => {
  const sw = boot({ fetch: offline });

  await sw.sessionOnCapture('proj-a', 'a/1.png');
  await sw.sessionFlush('project_changed');
  // The same Session fails again — 'suspend' and 'window_removed' both call
  // flush, so this is the ordinary case, not a contrived one.
  const s = await sw.sessionGet();
  if (s) { s.flushed = false; await sw.sessionSet(s); }
  await sw.sessionFlush('suspend');

  const q = await queued(sw);
  assert.strictEqual(q.length, 1, 'one entry per Session id, so a replay writes one document');
  assert.strictEqual(q[0].body.flushReason, 'suspend', 'and it is the most recent attempt that is kept');
});

test('the queue is capped at 50, dropping the oldest first', async () => {
  // Seeded full, so the next failure has to evict something. Asserted at the
  // point the cap is enforced — the write — rather than at the drain: growth
  // only ever happens on a failed flush, so that is the only place a bound can
  // be exceeded.
  const full = Array.from({ length: 50 }, (_, i) => ({
    body: { sessionId: `sess-${String(i).padStart(3, '0')}`, projectId: 'proj-old' },
    queuedAt: Date.now() + i
  }));

  const sw = boot({ local: { ...SETTINGS, sessionQueue: full }, fetch: offline });
  await sw.settle();

  await sw.sessionOnCapture('proj-new', 'new/1.png');
  await sw.sessionFlush('project_changed');

  const q = await queued(sw);
  assert.strictEqual(q.length, 50, 'the queue must not grow past its cap');

  const ids = q.map((e) => e.body.sessionId);
  assert.ok(!ids.includes('sess-000'), 'the oldest is the one dropped');
  assert.ok(ids.includes('sess-049'), 'the newest of the existing entries survives');
  assert.strictEqual(q[q.length - 1].body.projectId, 'proj-new',
    'and the Session that just failed is the one kept at the end');
});

;

test('a successful flush clears any stale queued copy of the same Session', async () => {
  // Otherwise the drain replays an older body over a newer one: the backend
  // merges on sessionId, so a stale copy would push sessionEnd backwards.
  let failNext = true;
  const flaky = async (url, opts) => {
    if (String(url).endsWith('/session-events')) {
      if (failNext) { failNext = false; throw new Error('Failed to fetch'); }
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const sw = boot({ fetch: flaky });

  await sw.sessionOnCapture('proj-a', 'a/1.png');
  await sw.sessionFlush('project_changed');
  assert.strictEqual((await queued(sw)).length, 1, 'the first attempt failed and was queued');

  const s = await sw.sessionGet();
  if (s) { s.flushed = false; await sw.sessionSet(s); }
  await sw.sessionFlush('suspend');

  assert.deepStrictEqual(await queued(sw), [],
    'the Session reached the backend, so the queued copy must not be replayed over it');
});

// ── The whole chain, in one test ────────────────────────────────────────────

test('flush fails → capture continues → drain → the outgoing project\'s Session is sent', async () => {
  // The acceptance criterion, walked end to end rather than in pieces. The
  // seam this exists to cover is the shape written by the queue and the shape
  // read by the drain: every other test states one side or the other by hand,
  // so the two could drift apart and each half would still pass.
  const offlineSw = boot({ fetch: offline });

  await offlineSw.sessionOnCapture('proj-a', 'a/1.png');
  await offlineSw.sessionOnCapture('proj-a', 'a/2.png');
  const b = await offlineSw.sessionOnCapture('proj-b', 'b/1.png');

  assert.strictEqual(b.isFirstInSession, true, 'the capture crossing the boundary is not blocked');
  // sessionEvents() lists *attempted* writes, so the offline attempt is in there;
  // what matters is that it did not succeed and the body was kept.
  assert.strictEqual((await queued(offlineSw)).length, 1, 'the failed write is waiting in the queue');

  // The next service-worker startup, with the storage the offline one left
  // behind and connectivity back. Nothing is copied by hand.
  const carried = await offlineSw.local.get(null);
  const onlineSw = boot({ local: carried });
  await onlineSw.settle();

  const events = sessionEvents(onlineSw.requests);
  assert.strictEqual(events.length, 1, 'the queued Session is sent once');

  const [sent] = events;
  assert.strictEqual(sent.projectId, 'proj-a', 'and it carries the outgoing project, not the incoming one');
  assert.strictEqual(sent.totalCaptures, 2);
  assert.strictEqual(sent.firstCapturePath, 'a/1.png');
  assert.strictEqual(sent.lastCapturePath, 'a/2.png');
  assert.strictEqual(sent.flushReason, 'project_changed');
  assert.ok(Date.parse(sent.sessionEnd) >= Date.parse(sent.sessionStart));

  const { sessionQueue = [] } = await onlineSw.local.get('sessionQueue');
  assert.deepStrictEqual(sessionQueue, [], 'and the queue is empty afterwards');
});

// ── The two ways a drain can end badly ──────────────────────────────────────

test('a revoked sign-in stops the drain and keeps everything queued', async () => {
  // #39: authedFetch has already spent the refresh token by the time a 401
  // reaches the drain, so the rest of the queue would get the same answer.
  const pending = ['a', 'b', 'c'].map((id) => ({
    body: { sessionId: `sess-${id}`, projectId: 'proj-a' }, queuedAt: Date.now()
  }));

  const expired = async (url) => {
    if (String(url).endsWith('/session-events')) return { ok: false, status: 401, text: async () => 'expired' };
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const sw = boot({ local: { ...SETTINGS, sessionQueue: pending }, fetch: expired });
  await sw.settle();

  assert.strictEqual(sessionEvents(sw.requests).length, 1,
    'it stops at the first 401 rather than asking three times for the same refusal');
  assert.strictEqual((await queued(sw)).length, 3,
    'and keeps all of them — signing back in must recover the time, not find it deleted');
});

test('a permanently refused Session is discarded rather than retried forever', async () => {
  // The realistic case is a Project purged out from under the Session, which
  // answers 403 for good. Keeping it would retry every startup and hold a slot
  // in a capped queue against Sessions that can still be written.
  const pending = [
    { body: { sessionId: 'sess-gone', projectId: 'purged-project' }, queuedAt: Date.now() },
    { body: { sessionId: 'sess-fine', projectId: 'proj-a' }, queuedAt: Date.now() }
  ];

  const fetchImpl = async (url, opts) => {
    if (String(url).endsWith('/session-events')) {
      const body = JSON.parse(opts.body);
      if (body.projectId === 'purged-project') return { ok: false, status: 403, text: async () => 'forbidden' };
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const sw = boot({ local: { ...SETTINGS, sessionQueue: pending }, fetch: fetchImpl });
  await sw.settle();

  assert.deepStrictEqual(await queued(sw), [], 'neither entry is left behind');
  const sent = sessionEvents(sw.requests).map((e) => e.sessionId);
  assert.ok(sent.includes('sess-fine'), 'the refusal must not block the Session behind it');
});

test('a rate-limited Session is kept, not discarded', async () => {
  // 429 is a 4xx that says "later", not "never" — the one distinction that
  // decides whether a Session survives a busy backend.
  const pending = [{ body: { sessionId: 'sess-busy', projectId: 'proj-a' }, queuedAt: Date.now() }];

  const throttled = async (url) => {
    if (String(url).endsWith('/session-events')) return { ok: false, status: 429, text: async () => 'slow down' };
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const sw = boot({ local: { ...SETTINGS, sessionQueue: pending }, fetch: throttled });
  await sw.settle();

  assert.strictEqual((await queued(sw)).length, 1, 'it waits for the next startup');
});
