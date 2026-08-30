'use strict';

// What the extension tells the server on the primary upload path — #66, #63.
//
// `POST /upload-url` is tried first and `POST /capture` is only a fallback. The
// backend now writes the `uploads` document from whichever path ran, so what
// this body carries decides what a Capture looks like in the Activity view, in
// the ZIP export and in every report.
//
// Two of these fields exist only because of the signed-URL path's shape: the
// image goes straight from the browser to Cloud Storage, so the backend never
// sees the bytes and cannot learn `size`, and it is not given the page address
// unless the extension says so. The proxy path has always sent both. If they
// stop being sent here, Captures are recorded with a blank address and an
// unknown size and nothing fails loudly.
//
// Run with: node --test extension/tests/

const test = require('node:test');
const assert = require('node:assert');
const { loadServiceWorker } = require('./sw-harness.js');

const TAB = { id: 1, windowId: 10, url: 'https://softomedia.test/campaigns', title: 'Campaigns' };

const READY = {
  settings: { cloudRunUrl: 'https://api.test/api', firebaseToken: 'test-token' },
  session: { projectId: 'proj-a', stage: 'media-buyer', tool: 'Softomedia' }
};

const RECT = { x: 40, y: 60, width: 320, height: 180 };

function bootAndCapture() {
  return loadServiceWorker({
    local: READY,
    tabs: [TAB],
    tabMessage: (_tabId, msg) =>
      (msg.type === 'SNIP_SELECT' ? { ok: true, rect: RECT, dpr: 2 } : undefined)
  });
}

const uploadUrlBody = (sw) =>
  sw.requests.find((r) => String(r.url).endsWith('/upload-url'))?.body;

test('the signed-URL request names the Project, the Tool and the Persona', async () => {
  const sw = bootAndCapture();
  await sw.send({ type: 'CAPTURE_SNIP' });

  const body = uploadUrlBody(sw);
  assert.ok(body, 'a request to /upload-url should have been made');

  assert.strictEqual(body.project, 'proj-a');
  assert.strictEqual(body.tool, 'Softomedia');
  assert.strictEqual(body.stage, 'media-buyer',
    'the Persona is sent as `stage`; the backend stores it (#63)');
});

test('the signed-URL request carries the page address', async () => {
  const sw = bootAndCapture();
  await sw.send({ type: 'CAPTURE_SNIP' });

  assert.strictEqual(uploadUrlBody(sw).tabUrl, TAB.url,
    'without this the uploads document has no address, and the export index has a blank column');
});

test('the signed-URL request declares the size the backend cannot see', async () => {
  const sw = bootAndCapture();
  await sw.send({ type: 'CAPTURE_SNIP' });

  const { size } = uploadUrlBody(sw);
  assert.strictEqual(typeof size, 'number', 'size must be a number the backend can store');
  assert.ok(size > 0, 'a Capture with no bytes is not a Capture');
});
