/**
 * #62 — the register that keeps a fire-and-forget write from outliving its suite.
 *
 * `stampLastCapture` is never awaited on the request path (AGENTS.md rule 4).
 * Under Jest that means a Firestore call can still be waiting on gRPC when the
 * environment is destroyed, and the late response lands in a torn-down world:
 *
 *   ReferenceError: You are trying to `require` a file after the Jest
 *   environment has been torn down. From tests/signed-url.test.js.
 *       at new GoogleErrorDecoder (google-gax/src/googleError.ts:169:28)
 *
 * Cloud Build 9e575881 died that way, and reported the failure against
 * capture-visible-loop.test.js — the suite that ran *next*, not the one that
 * leaked. That misattribution is the reason this is worth a test of its own:
 * the integration symptom is timing-dependent and points at the wrong file, so
 * asserting it end to end would be flaky and would blame the wrong thing.
 * These assertions are on the mechanism instead, and they are deterministic.
 *
 * No emulator, no app — this module is deliberately dependency-free so it can
 * be required from setupFilesAfterEnv in every suite.
 */
'use strict';

const { track, drain } = require('../src/lib/pendingWrites');

/** A promise settled by hand, so ordering is asserted rather than raced. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('track hands back the promise it was given, unchanged', () => {
  const d = deferred();
  expect(track(d.promise)).toBe(d.promise);
  d.resolve();
  return d.promise;
});

test('drain waits for an outstanding write', async () => {
  const d = deferred();
  let settled = false;
  track(d.promise.then(() => { settled = true; }));

  // The drain is started before the write finishes, which is the situation at
  // suite teardown: work is in flight and nothing has awaited it.
  const draining = drain();
  expect(settled).toBe(false);

  d.resolve();
  await draining;
  expect(settled).toBe(true);
});

test('drain does not reject when a tracked write failed', async () => {
  const d = deferred();
  // The real caller attaches its own .catch; this asserts the drain survives
  // even a promise that nobody handled, because a drain that throws at teardown
  // would fail the suite it is there to protect.
  track(d.promise);
  d.reject(new Error('firestore said no'));

  await expect(drain()).resolves.toEqual([
    expect.objectContaining({ status: 'rejected' }),
  ]);
});

test('a settled write is forgotten, so the register does not grow', async () => {
  const first = Promise.resolve('a');
  track(first);
  await first;
  // Let the finally callback run.
  await new Promise((r) => setImmediate(r));

  // Nothing outstanding: the drain has nothing left to wait for. Asserted by
  // its result rather than by reading the set, so the register stays private.
  await expect(drain()).resolves.toEqual([]);
});

test('drain is safe with nothing outstanding', async () => {
  await expect(drain()).resolves.toEqual([]);
});
