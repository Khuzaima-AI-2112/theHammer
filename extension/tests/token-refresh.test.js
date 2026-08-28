'use strict';

// Issue #39 — a Firebase ID token lives one hour, and nothing ever renewed it.
// The refresh token and API key were being stored at sign-in and never spent.
//
// Run with: npm run test:extension

const test = require('node:test');
const assert = require('node:assert');
const { loadPopup } = require('./popup-harness.js');

const REFRESH_HOST = 'https://securetoken.googleapis.com/v1/token';

const signedIn = (over = {}) => ({
  settings: {
    cloudRunUrl: 'https://backend.test',
    firebaseToken: 'expired-token',
    firebaseRefreshToken: 'refresh-1',
    firebaseApiKey: 'api-key-1',
    ...over
  }
});

const ok = (json) => ({ ok: true, status: 200, json: async () => json });
const unauthorised = () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthenticated: invalid token' }) });

/** Bearer token on a recorded request. */
const bearer = (r) => String(r.init?.headers?.Authorization || '').replace('Bearer ', '');

test('a 401 spends the refresh token and retries with the new one', async () => {
  const popup = loadPopup({
    local: signedIn(),
    fetch: async (url) => {
      if (url.startsWith(REFRESH_HOST)) return ok({ id_token: 'fresh-token', refresh_token: 'refresh-2' });
      return unauthorised();
    }
  });

  const res = await popup.authedFetch('https://backend.test/me/projects');

  const calls = popup.requests.map((r) => r.url);
  assert.strictEqual(calls.length, 3, `expected try/refresh/retry, got: ${JSON.stringify(calls)}`);
  assert.ok(calls[1].startsWith(REFRESH_HOST), 'the refresh was attempted second');
  assert.ok(calls[1].includes('key=api-key-1'), 'the stored API key is spent, not a hard-coded one');
  assert.strictEqual(bearer(popup.requests[2]), 'fresh-token', 'the retry carries the new token');
  assert.strictEqual(res.status, 401, 'the retry response is returned to the caller');
});

test('the renewed token and rotated refresh token are persisted', async () => {
  const popup = loadPopup({
    local: signedIn(),
    fetch: async (url) => url.startsWith(REFRESH_HOST)
      ? ok({ id_token: 'fresh-token', refresh_token: 'refresh-2' })
      : unauthorised()
  });

  await popup.refreshFirebaseToken();

  const { settings } = popup.local._peek();
  assert.strictEqual(settings.firebaseToken, 'fresh-token');
  assert.strictEqual(settings.firebaseRefreshToken, 'refresh-2', 'a rotated refresh token replaces the old one');
  assert.strictEqual(settings.cloudRunUrl, 'https://backend.test', 'the rest of settings survives');
});

test('a refresh response without a new refresh token keeps the existing one', async () => {
  const popup = loadPopup({
    local: signedIn(),
    fetch: async () => ok({ id_token: 'fresh-token' })
  });

  await popup.refreshFirebaseToken();

  assert.strictEqual(popup.local._peek().settings.firebaseRefreshToken, 'refresh-1');
});

test('a profile with no refresh token does not call Google at all', async () => {
  const popup = loadPopup({
    local: signedIn({ firebaseRefreshToken: '', firebaseApiKey: '' }),
    fetch: async () => unauthorised()
  });

  const token = await popup.refreshFirebaseToken();

  assert.strictEqual(token, '');
  assert.deepStrictEqual(popup.requests.map((r) => r.url), [], 'nothing was sent');
});

test('a refused refresh returns the original 401 rather than retrying', async () => {
  const popup = loadPopup({
    local: signedIn(),
    fetch: async (url) => url.startsWith(REFRESH_HOST)
      ? { ok: false, status: 400, json: async () => ({ error: 'TOKEN_EXPIRED' }) }
      : unauthorised()
  });

  const res = await popup.authedFetch('https://backend.test/me/projects');

  assert.strictEqual(res.status, 401);
  assert.strictEqual(popup.requests.length, 2, 'tried once, attempted the refresh, then stopped');
});

test('a healthy request is not retried and spends no refresh token', async () => {
  const popup = loadPopup({
    local: signedIn({ firebaseToken: 'good-token' }),
    fetch: async () => ok({ projects: [], total: 0 })
  });

  await popup.authedFetch('https://backend.test/me/projects');

  assert.strictEqual(popup.requests.length, 1);
  assert.strictEqual(bearer(popup.requests[0]), 'good-token');
});

// The user-visible win: an hour-old token used to empty the dropdown.
test('an expired token no longer empties the project dropdown', async () => {
  let projectCalls = 0;
  const popup = loadPopup({
    local: signedIn(),
    fetch: async (url) => {
      if (url.startsWith(REFRESH_HOST)) return ok({ id_token: 'fresh-token', refresh_token: 'refresh-2' });
      if (url.endsWith('/me/projects')) {
        projectCalls += 1;
        return projectCalls === 1 ? unauthorised() : ok({ projects: [{ id: 'p1', name: 'Alpha' }], total: 1 });
      }
      return ok({ backendUrl: 'https://backend.test' });
    }
  });

  await popup.fireDOMContentLoaded();

  assert.strictEqual(popup.el('project-single').textContent, 'Alpha',
    'the single project was listed after the token renewed itself');
  assert.strictEqual(popup.local._peek().settings.firebaseToken, 'fresh-token');
});
