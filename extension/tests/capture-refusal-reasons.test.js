'use strict';

// #72 — capture() returned a bare `null` from six different refusal sites, and
// both the message dispatcher and captureReply() flattened all six to the same
// `reason: 'blocked'`, which popup.js renders as "Blocked — set Project & save
// first." Two of the six are not configuration problems at all: a cancel, and
// an upload that failed but was queued (kept, not lost — AGENTS.md rule 4).
// Both were told they had misconfigured a Project.
//
// Each refusal now carries its own reason instead of collapsing into null, so
// the fix here is at the value capture() returns, not at any one display of it.
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

// ── Each refusal gets its own, correct reason ───────────────────────────────

test('a restricted page (chrome://) is refused as restricted, not as a Project problem', async () => {
  const sw = boot({ tabs: [{ id: 1, windowId: 10, url: 'chrome://extensions', title: 'Extensions' }] });

  const res = await sw.send({ type: 'CAPTURE' });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'restricted_page');
});

test('no Project set is refused as no_project', async () => {
  const sw = boot({ local: { settings: READY.settings } }); // no session at all

  const res = await sw.send({ type: 'CAPTURE' });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'no_project');
});

test('invalid screenshot data is refused as invalid_screenshot, not blocked', async () => {
  const sw = boot({ captureVisibleTabResult: 'data:image/png;base64,tooshort' });

  const res = await sw.send({ type: 'CAPTURE' });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'invalid_screenshot');
});

test('a PNG blob conversion failure is refused as blob_conversion_failed', async () => {
  const sw = boot({ blobFails: true });

  const res = await sw.send({ type: 'CAPTURE' });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'blob_conversion_failed');
});

test('cancelling the pre-upload privacy blur is refused as cancelled, not blocked', async () => {
  const sw = boot({
    local: { ...READY, settings: { ...READY.settings, allowPreUploadBlur: true } },
    tabMessage: (_tabId, msg) => (msg.type === 'BLUR_SCREENSHOT' ? { dataUrl: null } : undefined)
  });

  const res = await sw.send({ type: 'CAPTURE' });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'cancelled');
});

test('an upload that fails and gets queued is refused as queued, not blocked', async () => {
  // #39's fast path: an error carrying status 401 skips withRetry's backoff
  // entirely, so this does not wait out real retry delays.
  const sw = boot({
    fetch: async (url) => {
      if (String(url).endsWith('/upload-url')) {
        return { ok: false, status: 500, text: async () => 'signed-url service down' };
      }
      if (String(url).endsWith('/capture')) {
        return { ok: false, status: 401, text: async () => 'session expired' };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });

  const res = await sw.send({ type: 'CAPTURE' });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'queued');
});

test('a Capture refused as queued is actually kept, not lost', async () => {
  const sw = boot({
    fetch: async (url) => {
      if (String(url).endsWith('/upload-url')) return { ok: false, status: 500, text: async () => 'down' };
      if (String(url).endsWith('/capture'))    return { ok: false, status: 401, text: async () => 'expired' };
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });

  await sw.send({ type: 'CAPTURE' });

  const { queue = [] } = sw.local._peek();
  assert.strictEqual(queue.length, 1,
    'AGENTS.md rule 4: a screenshot must never be lost because a backend feature is down');
});

// ── The bug itself: no two refusals may share a reason ──────────────────────

test('no two different refusals produce the same reason', async () => {
  const scenarios = {
    restricted_page: boot({ tabs: [{ id: 1, windowId: 10, url: 'chrome://extensions' }] }),
    no_project: boot({ local: { settings: READY.settings } }),
    invalid_screenshot: boot({ captureVisibleTabResult: 'data:image/png;base64,tooshort' }),
    blob_conversion_failed: boot({ blobFails: true }),
    cancelled: boot({
      local: { ...READY, settings: { ...READY.settings, allowPreUploadBlur: true } },
      tabMessage: (_tabId, msg) => (msg.type === 'BLUR_SCREENSHOT' ? { dataUrl: null } : undefined)
    }),
    queued: boot({
      fetch: async (url) => {
        if (String(url).endsWith('/upload-url')) return { ok: false, status: 500, text: async () => 'down' };
        if (String(url).endsWith('/capture'))    return { ok: false, status: 401, text: async () => 'expired' };
        return { ok: true, status: 200, json: async () => ({}) };
      }
    })
  };

  const reasons = {};
  for (const [expected, sw] of Object.entries(scenarios)) {
    const res = await sw.send({ type: 'CAPTURE' });
    reasons[expected] = res.reason;
  }

  const values = Object.values(reasons);
  assert.strictEqual(new Set(values).size, values.length,
    `two refusals collapsed onto the same reason: ${JSON.stringify(reasons)}`);

  // And each one is the reason it claims to be — a seventh `return null` that
  // happened to keep the Set distinct would still be a regression.
  for (const [expected, actual] of Object.entries(reasons)) {
    assert.strictEqual(actual, expected);
  }
});

// ── A working Capture is unaffected ─────────────────────────────────────────

test('a normal Capture still succeeds and carries no reason', async () => {
  const sw = boot();

  const res = await sw.send({ type: 'CAPTURE' });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.reason, undefined);
});
