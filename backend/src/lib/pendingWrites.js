'use strict';

/**
 * The register of writes that outlive the request that started them (#62).
 *
 * `stampLastCapture` is deliberately never awaited: AGENTS.md rule 4 says
 * nothing may block the capture loop, and by the time it runs the Capture is
 * already recorded. The request answers and the write finishes on its own.
 *
 * That is right in production and a hazard under Jest. Each test file gets its
 * own module registry and environment, and Jest destroys it the moment the last
 * test resolves — while a fire-and-forget Firestore call is still waiting on
 * gRPC. The response then lands in a torn-down world, and the failure surfaces
 * as `ReferenceError: You are trying to require a file after the Jest
 * environment has been torn down` from inside google-gax's error decoder,
 * reported against *whichever suite happened to run next*. That is what broke
 * build 9e575881: the leak came from signed-url.test.js and the failure was
 * attributed to capture-visible-loop.test.js, which had done nothing wrong.
 *
 * So the promises are registered here and drained in a global `afterAll`
 * (tests/setup/drain-pending-writes.js, wired in jest.config.js). Every suite
 * gets it, including suites written later that never think about this — a
 * per-suite hook would be one somebody forgets, and the failure it prevents
 * lands on a different file than the one that caused it.
 *
 * Deliberately dependency-free. The setup file requires this module in every
 * suite, so it must pull in neither the app nor the Firestore client: doing so
 * would load the whole backend into suites that mock parts of it before
 * requiring it themselves.
 *
 * Nothing in production reads this. `track` keeps the set from growing without
 * bound by removing each promise as it settles, and `drain` exists for the
 * tests.
 */

const pending = new Set();

/**
 * Registers a promise as in-flight and returns it unchanged, so a caller can
 * write `track(doWrite())` without altering what it hands back.
 *
 * The promise is removed once it settles, so a long-running process holds only
 * what is genuinely outstanding. `finally` rather than `then`: a rejected write
 * must be forgotten too, and this must not swallow the rejection — the caller's
 * own `.catch` is what handles it.
 */
function track(promise) {
  pending.add(promise);
  promise.finally(() => pending.delete(promise)).catch(() => {});
  return promise;
}

/**
 * Waits for every outstanding write to settle. Never rejects: a failed
 * background write is the caller's business, not the drain's.
 */
function drain() {
  return Promise.allSettled([...pending]);
}

module.exports = { track, drain };
