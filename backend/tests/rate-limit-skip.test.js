/**
 * The global rate limiter still fires where it matters (#127)
 *
 * `index.js` skips its 60-req/IP/min limiter when `NODE_ENV === 'test'`. That
 * was necessary — the limiter keys on IP, a suite is one caller, and
 * storyboard-video.test.js sat one request under the ceiling, so #127 could
 * not add a test to it at all (lessons_learned 85).
 *
 * It is also the only security control in this repo that a test can switch
 * off, and before this file nothing exercised the limiter at all — so the skip
 * could have been widened, or the limiter deleted outright, with a green
 * suite either way. This is the test that notices.
 *
 * `skip` is evaluated per request rather than at construction, so flipping the
 * environment variable around a burst is enough; no module reloading needed.
 */
'use strict';

const request = require('supertest');

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock());

const { app } = require('../src/index');

/**
 * Fires `count` requests and answers with the statuses seen.
 *
 * Unauthenticated on purpose: the limiter runs ahead of `requireAuth` in the
 * middleware stack, so a refused request still counts, and this avoids caring
 * which routes exist.
 */
async function burst(count) {
  const statuses = [];
  for (let i = 0; i < count; i += 1) {
    const res = await request(app).get('/admin/reports?projectId=rate-limit-probe');
    statuses.push(res.status);
  }
  return statuses;
}

describe('the global rate limiter', () => {
  const realNodeEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = realNodeEnv; });

  test('answers 429 once the window is spent, when this is not a test run', async () => {
    // What a deployed revision is: cloudbuild.yaml sets NODE_ENV=production on
    // `gcloud run deploy --set-env-vars`, so this is the branch production
    // takes, and the skip below can never be the one it takes.
    process.env.NODE_ENV = 'production';

    const statuses = await burst(65);

    expect(statuses).toContain(429);
    // Not from the first request: the limit is a limit, not a closed door.
    expect(statuses[0]).not.toBe(429);
  });

  test('and never fires during the suite itself, which is why the skip exists', async () => {
    process.env.NODE_ENV = 'test';

    // Already well past the 60-request window spent by the test above, and on
    // the same key, so a limiter that did not skip would refuse every one.
    expect(await burst(5)).not.toContain(429);
  });
});
