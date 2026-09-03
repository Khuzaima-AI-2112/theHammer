'use strict';

// #92 — an offline-queued Capture never actually drained. queueAdd() stored
// blobToBase64(blob) under a field named blobBase64, but blobToBase64 returned
// FileReader's raw result — a full data URL (`data:image/png;base64,...`),
// not base64. The drain loop then called atob() directly on that string.
// atob() only accepts the base64 payload; the `data:image/png;base64,` prefix
// contains ':', '/', ';' and ',', none of them valid base64 characters, so
// every decode threw and every item was moved into `failed` — an array
// nothing in the codebase ever reads back. Found manually verifying #72's
// `queued` reason: two real queued items, reloaded to force a drain, both
// failed with "The string to be decoded is not correctly encoded."
//
// Fixed at the write site: blobToBase64 now returns what its name promises.
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

function boot(opts) {
  return loadServiceWorker({ local: READY, tabs: [TAB], ...opts });
}

// #39's fast path: an error carrying status 401 skips withRetry's backoff
// entirely, so a test using this does not wait out real retry delays.
const offlineFetch = async (url) => {
  if (String(url).endsWith('/upload-url')) return { ok: false, status: 500, text: async () => 'down' };
  if (String(url).endsWith('/capture'))    return { ok: false, status: 401, text: async () => 'expired' };
  return { ok: true, status: 200, json: async () => ({}) };
};

// ── The unit: blobToBase64 returns base64, not a data URL ──────────────────

test('blobToBase64 does not carry the data: URL prefix', async () => {
  const sw = boot();
  const blob = new Blob(['hello'], { type: 'text/plain' });

  const result = await sw.blobToBase64(blob);

  assert.ok(!result.startsWith('data:'),
    `a field named blobBase64 must be base64, not a data URL: ${result.slice(0, 40)}`);
});

test('blobToBase64 decodes back to the original bytes', async () => {
  const sw = boot();
  const blob = new Blob(['hello'], { type: 'text/plain' });

  const result = await sw.blobToBase64(blob);

  assert.strictEqual(Buffer.from(result, 'base64').toString('utf8'), 'hello');
});

// ── The regression: a queued item actually drains ───────────────────────────

test('a Capture that gets queued offline can be decoded straight back to bytes', async () => {
  // The exact shape queueAdd() writes, decoded the way the drain loop does.
  // This is the assertion that would have caught #92 directly: it is not
  // enough for an item to reach the queue (#72 already covers that) — the
  // stored value has to survive round-tripping through atob().
  const sw = boot({ fetch: offlineFetch });

  await sw.send({ type: 'CAPTURE' });

  const { queue = [] } = sw.local._peek();
  assert.strictEqual(queue.length, 1);

  assert.doesNotThrow(() => Buffer.from(queue[0].blobBase64, 'base64'),
    'the stored blobBase64 must be plain base64 — this is what atob() chokes on in Chrome');
  assert.ok(!queue[0].blobBase64.startsWith('data:'));
});

test('a queued Capture successfully drains once connectivity returns, instead of moving to failed', async () => {
  // First: queue an item offline, the same way #72's queued test does.
  const offline = boot({ fetch: offlineFetch });
  await offline.send({ type: 'CAPTURE' });
  const { queue } = offline.local._peek();
  assert.strictEqual(queue.length, 1, 'setup: the item must reach the queue before this test means anything');

  // Second: a fresh service-worker "restart" — sw-harness's drain IIFE runs at
  // load, the same way service-worker.js's does on a real SW startup — seeded
  // with that exact queued item, and a backend that now succeeds.
  const online = boot({ local: { ...READY, queue } });
  await online.settle();

  const after = online.local._peek();
  assert.deepStrictEqual(after.queue ?? [], [], 'the drained item must leave the queue');
  assert.deepStrictEqual(after.failed ?? [], [],
    'this is #92 itself: a decode failure silently moved the item to failed, ' +
    'an array nothing ever reads back — the screenshot was never lost from ' +
    'storage, but it was lost from the product');

  const uploadRequest = online.requests.find((r) => String(r.url).endsWith('/upload-url'));
  assert.ok(uploadRequest, 'a successfully drained item must actually reach the backend');
});
