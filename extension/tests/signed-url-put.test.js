'use strict';

// #70 — the signed-URL PUT had never once succeeded in production.
//
// `xhrPut` opened the upload with `new XMLHttpRequest()`. A Manifest V3 service
// worker has no XMLHttpRequest: the worker global scope offers fetch and
// nothing else. So the call threw `ReferenceError: XMLHttpRequest is not
// defined` on its first statement, before it ever opened a connection, on every
// Capture since the signed-URL path was written.
//
// Nothing looked broken. The catch around it treats a ReferenceError exactly
// like a network failure, so every Capture quietly took the /capture proxy
// fallback, and since #69 the fallback resumes the recorded path — one Capture,
// one row, correct picture. The only evidence was one console line:
//
//   [Hammer SW] XHR PUT failed, using proxy: XMLHttpRequest is not defined
//
// on all ~51 Captures of the 2026-08-31 run. The cost is every screenshot's
// bytes travelling through Cloud Run instead of straight to Cloud Storage.
//
// The tests below are in two layers, and the second is the one that matters.
// The behavioural tests would have caught this only because sw-harness.js no
// longer defines XMLHttpRequest — the old harness supplied a FakeXHR, which is
// why a fully tested path could never run. The static test needs no harness and
// cannot be fooled by one.
//
// Run with: npm run test:extension

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadServiceWorker } = require('./sw-harness.js');

const TAB = { id: 1, windowId: 10, url: 'https://softomedia.test/campaigns', title: 'Campaigns' };

const READY = {
  settings: { cloudRunUrl: 'https://api.test/api', firebaseToken: 'test-token' },
  session: { projectId: 'proj-a', stage: 'media-buyer', tool: 'Softomedia' }
};

const RECT = { x: 40, y: 60, width: 320, height: 180 };
const SIGNED_PUT = 'https://gcs.test/signed-put';

function boot(opts) {
  return loadServiceWorker({
    local: READY,
    tabs: [TAB],
    tabMessage: (_tabId, msg) =>
      (msg.type === 'SNIP_SELECT' ? { ok: true, rect: RECT, dpr: 2 } : undefined),
    ...opts
  });
}

const putRequest    = (sw) => sw.requests.find((r) => String(r.url) === SIGNED_PUT);
const captureRequest = (sw) => sw.requests.find((r) => String(r.url).endsWith('/capture'));

// ── The runtime the worker actually has ──────────────────────────────

test('the sandbox has no XMLHttpRequest, because a service worker has none', () => {
  const sw = boot();
  assert.strictEqual(sw.hasXMLHttpRequest, false,
    'a harness that supplies XMLHttpRequest tests code that cannot run in MV3');
});

// ── Behaviour ────────────────────────────────────────────────────────

test('a healthy Capture PUTs its bytes to the signed URL', async () => {
  const sw = boot();
  await sw.send({ type: 'CAPTURE_SNIP' });
  await sw.settle();

  const put = putRequest(sw);
  assert.ok(put, 'the bytes must go straight to Cloud Storage');
  assert.strictEqual(put.init.method, 'PUT');
  assert.strictEqual(put.init.headers['Content-Type'], 'image/png');
  assert.ok(put.init.body, 'the PUT must carry the image');
});

test('a healthy Capture does not touch the proxy at all', async () => {
  const sw = boot();
  await sw.send({ type: 'CAPTURE_SNIP' });
  await sw.settle();

  assert.strictEqual(captureRequest(sw), undefined,
    'this is the whole bug: every Capture was falling back to /capture, so every ' +
    'screenshot travelled through Cloud Run');
});

test('no Capture reports a missing XMLHttpRequest', async () => {
  const sw = boot();
  await sw.send({ type: 'CAPTURE_SNIP' });
  await sw.settle();

  const complaint = sw.logs.warn.find((l) => /XMLHttpRequest is not defined/.test(l));
  assert.strictEqual(complaint, undefined,
    `the production symptom, verbatim: ${complaint}`);
});

test('a refused PUT still falls back to the proxy', async () => {
  // The fallback is the right behaviour and must survive the fix — the PUT goes
  // straight to the bucket, so a CORS policy that does not name the extension
  // origin genuinely refuses it.
  const sw = boot({ putFails: true });
  await sw.send({ type: 'CAPTURE_SNIP' });
  await sw.settle();

  assert.ok(captureRequest(sw), 'a refused PUT must still get the Capture to the server');
});

test('a refused PUT says so, with the status the bucket gave', async () => {
  const sw = boot({ putFails: true });
  await sw.send({ type: 'CAPTURE_SNIP' });
  await sw.settle();

  const warned = sw.logs.warn.join('\n');
  assert.match(warned, /403/,
    'the console line is the only signal a Capture proxied; it has to name the cause');
});

test('the popup is told the upload finished', async () => {
  // 4.3's progress bar. XHR reported it continuously; fetch cannot report
  // upload progress at all, so this path is coarse by design — but it must
  // still reach 100, or the bar sticks below full on every Capture.
  const sw = boot();
  await sw.send({ type: 'CAPTURE_SNIP' });
  await sw.settle();

  const percents = sw.internalMessages
    .filter((m) => m.type === 'UPLOAD_PROGRESS')
    .map((m) => m.percent);

  assert.ok(percents.includes(100), `never reached 100: ${JSON.stringify(percents)}`);
});

// ── The guard that does not depend on the harness ────────────────────

test('no file that runs in the service worker references XMLHttpRequest', () => {
  // The behavioural tests above only work because this harness was corrected.
  // A future harness could supply the global again, or the API could be reached
  // from a file this suite never loads. This reads the source instead.
  //
  // popup.js and content scripts run in a document and legitimately have XHR;
  // only worker-scope files are covered.
  const WORKER_SCOPE = ['service-worker.js', 'auth.js'];

  // Comments are blanked rather than the file being searched whole, so that
  // writing down *why* the API is banned does not trip the ban. Line count is
  // preserved so the failure can name the line.
  const withoutComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\r\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\r\n]*/g, (_m, before) => before);

  for (const file of WORKER_SCOPE) {
    const full = path.join(__dirname, '..', file);
    const code = withoutComments(fs.readFileSync(full, 'utf8'));
    const hit = code.split(/\r?\n/).findIndex((l) => /\bXMLHttpRequest\b/.test(l));
    assert.strictEqual(hit, -1,
      `${file}:${hit + 1} uses XMLHttpRequest, which does not exist in a Manifest V3 ` +
      `service worker. It throws ReferenceError at runtime and any catch around it ` +
      `turns that into a silent fallback. Use fetch.`);
  }
});
