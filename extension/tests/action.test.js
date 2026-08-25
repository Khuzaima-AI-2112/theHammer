'use strict';

// The three-way action icon — issue #11, ADR-0009.
//
// Covers ACT-02 (snip returns a rectangle, Escape cancels), ACT-03 (a tab with
// no content script falls back to a full capture) and ACT-05 (the popup being
// open while the offline queue holds items changes neither).
//
// ACT-01 is covered by omission rather than assertion: the plain screenshot
// paths are untouched, and extension/tests/session.test.js still exercises them.
// The overlay itself lives in content.js and needs a DOM, which no harness here
// provides — that is issue #5's job, so the overlay was checked by hand.
//
// Run with: node --test extension/tests/

const test = require('node:test');
const assert = require('node:assert');
const { loadServiceWorker } = require('./sw-harness.js');

const TAB = { id: 1, windowId: 10, url: 'https://example.test/page', title: 'Example' };

const READY = {
  settings: { cloudRunUrl: 'https://api.test/api', firebaseToken: 'test-token' },
  session:  { projectId: 'proj-a', stage: 'during', tool: 'Figma' }
};

const RECT = { x: 40, y: 60, width: 320, height: 180 };

/** Boot a worker whose active tab answers SNIP_SELECT with `snip`. */
function bootWithSnip(snip, overrides = {}) {
  return loadServiceWorker({
    local: READY,
    tabs: [TAB],
    tabMessage: (_tabId, msg) => (msg.type === 'SNIP_SELECT' ? snip : undefined),
    ...overrides
  });
}

const cropMessages = (sw) => sw.internalMessages.filter((m) => m.type === 'CROP_IMAGE');

test('ACT-02: a snipped rectangle reaches capture() and is cropped to', async () => {
  const sw = bootWithSnip({ ok: true, rect: RECT, dpr: 2 });

  const res = await sw.send({ type: 'CAPTURE_SNIP' });

  assert.deepStrictEqual(sw.tabs.captures, [TAB.windowId], 'the visible tab is captured exactly once');

  const crops = cropMessages(sw);
  assert.strictEqual(crops.length, 1, 'the capture is cropped');
  assert.deepStrictEqual(crops[0].rect, RECT, 'the rectangle arrives at the crop unchanged');
  assert.strictEqual(crops[0].dpr, 2, 'so does the device pixel ratio');

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.fellBack, undefined, 'nothing fell back');
  assert.ok(
    sw.requests.some((r) => String(r.url).endsWith('/upload-url')),
    'the cropped image is uploaded'
  );
});

test('ACT-02: Escape captures nothing and says nothing', async () => {
  const sw = bootWithSnip({ ok: false, reason: 'cancelled' });

  const res = await sw.send({ type: 'CAPTURE_SNIP' });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'cancelled');
  assert.deepStrictEqual(sw.tabs.captures, [], 'no screenshot was taken');
  assert.deepStrictEqual(cropMessages(sw), [], 'nothing was cropped');
  assert.deepStrictEqual(sw.notifications, [], 'cancelling on purpose is not an error to report');
  assert.deepStrictEqual(sw.requests, [], 'nothing was uploaded');
});

test('ACT-03: a tab with no content script falls back to a full capture', async () => {
  const sw = loadServiceWorker({
    local: READY,
    tabs: [TAB],
    // What chrome reports when nothing is listening in the tab.
    tabMessage: () => ({ __lastError: 'Could not establish connection. Receiving end does not exist.' })
  });

  const res = await sw.send({ type: 'CAPTURE_SNIP' });

  assert.strictEqual(res.ok, true, 'the capture still happened');
  assert.strictEqual(res.fellBack, true, 'and the popup is told it was not the region they chose');
  assert.deepStrictEqual(sw.tabs.captures, [TAB.windowId], 'a whole-page capture was taken');
  assert.deepStrictEqual(cropMessages(sw), [], 'with no crop, because there is no rectangle');
  assert.ok(
    sw.requests.some((r) => String(r.url).endsWith('/upload-url')),
    'the fallback capture is uploaded like any other'
  );
});

test('ACT-03: a genuinely restricted URL is refused rather than faked', async () => {
  // capture()'s own URL guard stops before any screenshot on chrome:// pages,
  // so the fallback cannot help here and does not pretend to. ADR-0009.
  const sw = loadServiceWorker({
    local: READY,
    tabs: [{ id: 2, windowId: 10, url: 'chrome://settings', title: 'Settings' }],
    tabMessage: () => ({ __lastError: 'Cannot access a chrome:// URL' })
  });

  const res = await sw.send({ type: 'CAPTURE_SNIP' });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.fellBack, true, 'the fallback was attempted');
  assert.deepStrictEqual(sw.tabs.captures, [], 'but no screenshot was taken');
  assert.strictEqual(sw.notifications.length, 1, 'the person is told why');
  assert.match(sw.notifications[0].title, /Cannot capture this page/);
});

test('full page uses the page it was handed and takes no screenshot of its own', async () => {
  const sw = loadServiceWorker({
    local: READY,
    tabs: [TAB],
    tabMessage: (_tabId, msg) =>
      msg.type === 'START_FULLPAGE_CAPTURE'
        ? { ok: true, dataUrl: 'data:image/png;base64,' + 'B'.repeat(12000) }
        : undefined
  });

  const res = await sw.send({ type: 'CAPTURE_FULLPAGE' });

  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(sw.tabs.captures, [], 'the stitched page is used, not captureVisibleTab');
  assert.deepStrictEqual(cropMessages(sw), [], 'a full page is not cropped');
});

// The worker drains the offline queue as it starts, so "the popup is used while
// a capture is queued" is not a hypothetical here — the drain is genuinely in
// flight while the snip runs. ACT-05 asks that nothing be dropped, not that the
// queue be left alone.
const queuedItem = (n) => ({
  blobBase64: btoa('queued-' + n),
  session: { projectId: 'proj-a', tool: 'Figma' },
  tabUrl: `https://${n}.test`,
  ts: n,
  attempts: 0
});

const uploads = (sw) => sw.requests.filter((r) => String(r.url).endsWith('/upload-url')).length;

test('ACT-05: snipping while the queue drains loses neither the queued captures nor the new one', async () => {
  const queued = [queuedItem(1), queuedItem(2)];
  const sw = bootWithSnip({ ok: true, rect: RECT, dpr: 1 }, {
    local: { ...READY, queue: queued, failed: [] }
  });

  const res = await sw.send({ type: 'CAPTURE_SNIP' });
  assert.strictEqual(res.ok, true, 'the new capture goes through');
  await sw.settle();

  assert.strictEqual(uploads(sw), 3, 'both queued captures were uploaded, and so was the snip');

  const { queue, failed } = sw.local._peek();
  assert.deepStrictEqual(queue, [], 'the queue emptied because everything in it went up');
  assert.deepStrictEqual(failed, [], 'nothing was given up on');
});

test('ACT-05: a cancelled snip while the queue drains drops nothing either', async () => {
  const queued = [queuedItem(1)];
  const sw = bootWithSnip({ ok: false, reason: 'cancelled' }, {
    local: { ...READY, queue: queued, failed: [] }
  });

  await sw.send({ type: 'CAPTURE_SNIP' });
  await sw.settle();

  assert.strictEqual(uploads(sw), 1, 'the queued capture still went up; the cancel added none');
  assert.deepStrictEqual(sw.local._peek().failed, [], 'and none were given up on');
});
