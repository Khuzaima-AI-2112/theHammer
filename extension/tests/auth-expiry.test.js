'use strict';

// Issue #39, third `Done when`: "A 401 that survives one refresh attempt reports
// that sign-in is required, rather than retrying forever or reporting a generic
// failure."
//
// authedFetch got that right in isolation, but nothing downstream could tell a
// dead session from a dead network. withRetry retried the fatal 401 three more
// times and the capture path then reported "No connection — will retry when
// online", which is the wrong thing to tell someone whose session expired.
// This is lessons_learned.md 52 and 55 again: one message for two causes.
//
// Run with: npm run test:extension

const test = require('node:test');
const assert = require('node:assert');
const { loadServiceWorker } = require('./sw-harness.js');

const SETTINGS = {
  settings: { cloudRunUrl: 'https://api.test/api', firebaseToken: 'test-token' }
};

const boot = () => loadServiceWorker({ local: SETTINGS });

/** The shape service-worker.js throws once a response comes back not-ok. */
const httpError = (status) => {
  const err = new Error(`/capture HTTP ${status} — denied`);
  err.status = status;
  return err;
};

/**
 * sw-harness unrefs every timer inside the worker, so that a guard left pending
 * cannot hold the test process open. withRetry's backoff is one of those timers,
 * so a test that waits through a real retry needs something ref'd in this realm
 * to keep the event loop alive, or node kills the run mid-await.
 */
async function withLiveTimers(fn) {
  const keepAlive = setInterval(() => {}, 50);
  try { return await fn(); } finally { clearInterval(keepAlive); }
}

test('a 401 is recognised as a dead session, and a 500 is not', () => {
  const sw = boot();

  assert.strictEqual(sw.isAuthExpired(httpError(401)), true);
  assert.strictEqual(sw.isAuthExpired(httpError(500)), false);
  assert.strictEqual(sw.isAuthExpired(httpError(403)), false,
    '403 is an authorisation problem, not an expired session — signing in again will not help');
  assert.strictEqual(sw.isAuthExpired(new Error('network down')), false,
    'an error with no status must not be mistaken for an auth failure');
});

test('withRetry gives up immediately on a 401 instead of retrying it', async () => {
  const sw = boot();

  let attempts = 0;
  const started = Date.now();
  await assert.rejects(
    () => sw.withRetry(async () => { attempts += 1; throw httpError(401); }),
    (err) => err.message.includes('401')
  );

  assert.strictEqual(attempts, 1,
    'the 401 already survived a refresh inside authedFetch; retrying it cannot change the answer');
  assert.ok(Date.now() - started < 500,
    'giving up on a dead session must not cost the 7s of backoff a network failure does');
});

test('withRetry still retries a genuine transport failure', async () => {
  const sw = boot();

  let attempts = 0;
  await withLiveTimers(() => assert.rejects(
    () => sw.withRetry(async () => { attempts += 1; throw new Error('network down'); }),
    (err) => err.message === 'network down'
  ));

  assert.strictEqual(attempts, 3, 'a transient failure should still get all three attempts');
});

test('withRetry returns the value when the call eventually succeeds', async () => {
  const sw = boot();

  let attempts = 0;
  const result = await withLiveTimers(() => sw.withRetry(async () => {
    attempts += 1;
    if (attempts < 2) throw new Error('network down');
    return { path: 'gs://bucket/a.png' };
  }));

  assert.strictEqual(result.path, 'gs://bucket/a.png');
  assert.strictEqual(attempts, 2);
});

test('an expired session is reported as sign-in required, not as being offline', () => {
  const sw = boot();

  const notice = sw.uploadFailureNotice(httpError(401));

  assert.strictEqual(notice.title, 'Sign in required');
  assert.match(notice.message, /sign in/i);
  assert.doesNotMatch(notice.message, /connection|offline|online/i,
    'blaming the network for an expired session is the defect this test exists to stop');
});

test('a real transport failure is still reported as queued and offline', () => {
  const sw = boot();

  const notice = sw.uploadFailureNotice(new Error('network down'));

  assert.strictEqual(notice.title, 'Upload queued');
  assert.match(notice.message, /retry when online/i);
});

test('the capture is kept whichever way the upload failed', () => {
  // AGENTS.md rule 4: the Core Loop is sacred and a screenshot must never be
  // lost because a backend feature is down. Both notices must therefore say the
  // capture survived, or promise a later retry that implies it.
  const sw = boot();

  assert.match(sw.uploadFailureNotice(httpError(401)).message, /saved/i);
  assert.match(sw.uploadFailureNotice(new Error('network down')).message, /retry/i);
});
