'use strict';

// The API base URL — issue #26.
//
// The backend mounts /config, /me/projects, /upload-url and /session-events at
// the root. Both hard-coded fallbacks used to carry an `/api` prefix that no
// route answers, so every call 404'd on a fresh install. These tests assert the
// prefix cannot come back, from the constant or from a cached settings value.
//
// Run with: npm run test:extension

const test = require('node:test');
const assert = require('node:assert');
const { loadServiceWorker, sessionEvents } = require('./sw-harness.js');

const TOKEN = 'test-token';

/** Let the worker's startup work finish. */
const settle = async (ticks = 20) => {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r));
};

/**
 * Two captures against different projects force a Session flush, which is the
 * cheapest way to make the worker actually call the backend.
 */
async function flushOnce(sw) {
  await sw.sessionOnCapture('proj-a', 'a/1.png');
  await sw.sessionOnCapture('proj-b', 'b/1.png');
  return sw.requests.map((r) => String(r.url));
}

test('the built-in fallback URL has no /api prefix', async () => {
  const sw = loadServiceWorker({ local: { settings: { firebaseToken: TOKEN } } });

  const urls = await flushOnce(sw);

  assert.strictEqual(urls.length, 1, 'the outgoing Session was written');
  assert.ok(urls[0].endsWith('/session-events'), `unexpected path: ${urls[0]}`);
  assert.ok(!urls[0].includes('/api/'), `the /api prefix is back: ${urls[0]}`);
});

test('a cached /api URL is not used, so an existing profile is not stuck', async () => {
  const sw = loadServiceWorker({
    local: {
      settings: {
        cloudRunUrl: 'https://backend.test/api',
        firebaseToken: TOKEN
      }
    }
  });

  const urls = await flushOnce(sw);

  assert.deepStrictEqual(urls, ['https://backend.test/session-events'],
    'the stored prefix is stripped where the URL is read');
  assert.strictEqual(sessionEvents(sw.requests).length, 1, 'and the write still happened');
});

test('a trailing slash does not produce a double slash', async () => {
  const sw = loadServiceWorker({
    local: {
      settings: {
        cloudRunUrl: 'https://backend.test/api/',
        firebaseToken: TOKEN
      }
    }
  });

  const urls = await flushOnce(sw);

  assert.deepStrictEqual(urls, ['https://backend.test/session-events']);
});

test('a URL that never had the prefix is left exactly as it is', async () => {
  const sw = loadServiceWorker({
    local: {
      settings: {
        cloudRunUrl: 'https://backend.test',
        firebaseToken: TOKEN
      }
    }
  });

  const urls = await flushOnce(sw);

  assert.deepStrictEqual(urls, ['https://backend.test/session-events']);
});

test('a cached /api URL is cleaned out of storage at startup', async () => {
  const sw = loadServiceWorker({
    local: {
      settings: {
        cloudRunUrl: 'https://backend.test/api',
        firebaseToken: TOKEN,
        notify: true
      }
    }
  });

  await settle();

  const { settings } = sw.local._peek();
  assert.strictEqual(settings.cloudRunUrl, 'https://backend.test',
    'the stored value is rewritten, so the Settings panel stops showing a dead URL');
  assert.strictEqual(settings.firebaseToken, TOKEN, 'the rest of settings survives');
  assert.strictEqual(settings.notify, true);
});

test('storage is left alone when there is nothing to clean', async () => {
  const before = { cloudRunUrl: 'https://backend.test', firebaseToken: TOKEN };
  const sw = loadServiceWorker({ local: { settings: { ...before } } });

  await settle();

  assert.deepStrictEqual(sw.local._peek().settings, before);
});
