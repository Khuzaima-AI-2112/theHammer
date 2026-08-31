'use strict';

// One Capture must be recorded once — the 2026-08-31 report: three Captures
// appeared in the Activity view as six rows, in pairs.
//
// The extension has two ways to get a Capture to the server. It asks
// /upload-url for a signed URL and PUTs the bytes straight to Cloud Storage;
// if anything in that goes wrong it falls back to /capture, which proxies the
// bytes through the backend.
//
// Since #66 BOTH routes write an `uploads` document, and the document's id is
// the object path. So the fallback stopped being free: when the PUT fails, the
// Capture has already been recorded by /upload-url, and a /capture that builds
// a fresh path records it a second time. Two rows, one image — and the first
// row points at bytes that were never PUT, which is what an export cannot
// download.
//
// The fix is that the fallback resumes the recorded path, so the second write
// updates that same document. These tests hold the extension's half of it: that
// the path is carried over, and only when there is one to carry.
//
// The PUT failing is the ordinary case, not an exotic one: it goes from the
// extension straight to the bucket, so it is refused whenever the bucket's CORS
// policy does not name the extension origin.
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

const RECT = { x: 40, y: 60, width: 320, height: 180 };

/** The path the harness's /upload-url answers with. */
const RECORDED_PATH = 'uploads/test.png';

function boot(opts) {
  return loadServiceWorker({
    local: READY,
    tabs: [TAB],
    tabMessage: (_tabId, msg) =>
      (msg.type === 'SNIP_SELECT' ? { ok: true, rect: RECT, dpr: 2 } : undefined),
    ...opts
  });
}

/** The multipart body of the /capture request, if the proxy fallback ran. */
function captureForm(sw) {
  const req = sw.requests.find((r) => String(r.url).endsWith('/capture'));
  return req ? req.init.body : null;
}

test('a PUT failure sends the Capture down the proxy path', async () => {
  const sw = boot({ putFails: true });
  await sw.send({ type: 'CAPTURE_SNIP' });
  await sw.settle();

  assert.ok(captureForm(sw), 'the proxy fallback should have run');
});

test('the proxy fallback resumes the path /upload-url already recorded', async () => {
  const sw = boot({ putFails: true });
  await sw.send({ type: 'CAPTURE_SNIP' });
  await sw.settle();

  assert.strictEqual(captureForm(sw).get('resumePath'), RECORDED_PATH,
    'without this the backend builds a second path, the uploads doc id differs, ' +
    'and one Capture becomes two rows — the first pointing at bytes never PUT');
});

test('a Capture that never reached /upload-url resumes nothing', async () => {
  // /upload-url itself failed, so no document was recorded and there is no path
  // to resume. Sending a stale one here would overwrite an unrelated Capture.
  const sw = boot({
    fetch: async (url) => {
      if (String(url).endsWith('/upload-url')) {
        return { ok: false, status: 500, text: async () => 'boom' };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, path: 'p.png' }) };
    }
  });
  await sw.send({ type: 'CAPTURE_SNIP' });
  await sw.settle();

  const form = captureForm(sw);
  assert.ok(form, 'the proxy fallback should have run');
  assert.strictEqual(form.get('resumePath'), null,
    'no document was recorded, so there is no path to resume');
});
