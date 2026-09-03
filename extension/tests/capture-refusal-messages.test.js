'use strict';

// #72 — every capture() refusal reached the popup as reason: 'blocked' (or
// nothing at all), and popup.js rendered that single value as "Blocked — set
// Project & save first." regardless of what actually happened. service-worker.js
// now returns a distinct reason per refusal (capture-refusal-reasons.test.js);
// this file is the other half — the popup has to say something true for each
// one, not just something that isn't wrong.
//
// Two of the six are the ones that matter most: 'cancelled' (they cancelled,
// not misconfigured anything) and 'queued' (the screenshot was kept — AGENTS.md
// rule 4 — not lost).
//
// Run with: npm run test:extension

const test = require('node:test');
const assert = require('node:assert');
const { loadPopup } = require('./popup-harness.js');

const SIGNED_IN = {
  settings: { cloudRunUrl: 'https://api.test/api', firebaseToken: 'test-token' },
  session:  { projectId: 'proj-a', stage: 'beginning', tool: 'Softomedia' }
};

async function openPopup() {
  const popup = loadPopup({
    local: SIGNED_IN,
    fetch: async (url) => {
      if (url.endsWith('/me/projects')) {
        return { ok: true, status: 200, json: async () => ({ projects: [
          { projectId: 'proj-a', name: 'Persona — Media Buyer' }
        ] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });
  await popup.fireDOMContentLoaded();
  await popup.settle();
  return popup;
}

const status = (popup) => String(popup.el('status').textContent ?? '');

/** Drive Capture Now with a scripted service-worker response. */
async function captureNowWith(popup, response) {
  popup.chrome.runtime.sendMessage = (msg, cb) => cb(response);
  popup.el('capture-btn').click();
  await popup.settle();
}

// ── Each reason gets its own, correct message ───────────────────────────────

test('no_project is still reported as a Project problem — this one is true', async () => {
  const popup = await openPopup();
  await captureNowWith(popup, { ok: false, reason: 'no_project' });

  assert.match(status(popup), /set Project & save first/i);
});

test('restricted_page does not blame the Project', async () => {
  const popup = await openPopup();
  await captureNowWith(popup, { ok: false, reason: 'restricted_page' });

  assert.doesNotMatch(status(popup), /set Project & save first/i);
});

test('invalid_screenshot does not blame the Project', async () => {
  const popup = await openPopup();
  await captureNowWith(popup, { ok: false, reason: 'invalid_screenshot' });

  assert.doesNotMatch(status(popup), /set Project & save first/i);
});

test('blob_conversion_failed does not blame the Project', async () => {
  const popup = await openPopup();
  await captureNowWith(popup, { ok: false, reason: 'blob_conversion_failed' });

  assert.doesNotMatch(status(popup), /set Project & save first/i);
});

test('cancelled is reported as a cancel, not a Project problem', async () => {
  const popup = await openPopup();
  await captureNowWith(popup, { ok: false, reason: 'cancelled' });

  assert.match(status(popup), /cancel/i);
  assert.doesNotMatch(status(popup), /set Project & save first|blocked/i);
});

test('queued says the capture was kept, not blocked or lost', async () => {
  const popup = await openPopup();
  await captureNowWith(popup, { ok: false, reason: 'queued' });

  assert.doesNotMatch(status(popup), /set Project & save first|blocked/i,
    'this is the false positive: the screenshot is safe, not a config mistake');
  assert.doesNotMatch(status(popup), /fail/i,
    'the capture succeeded at being kept — it did not fail');
});

// ── The bug itself: no two different refusals share a message ──────────────

test('no two different refusal reasons produce the same status text', async () => {
  const reasons = [
    'no_project', 'restricted_page', 'invalid_screenshot',
    'blob_conversion_failed', 'cancelled', 'queued'
  ];

  const messages = {};
  for (const reason of reasons) {
    const popup = await openPopup();
    await captureNowWith(popup, { ok: false, reason });
    messages[reason] = status(popup);
  }

  const values = Object.values(messages);
  assert.strictEqual(new Set(values).size, values.length,
    `two refusals produced the same status text: ${JSON.stringify(messages, null, 2)}`);
});

// ── Untouched paths still work ───────────────────────────────────────────────

test('a successful Capture still says so', async () => {
  const popup = await openPopup();
  await captureNowWith(popup, { ok: true, path: 'uploads/test.png' });

  assert.match(status(popup), /uploaded/i);
});

test('no_api_key still sends the person to sign in', async () => {
  const popup = await openPopup();
  await captureNowWith(popup, { ok: false, reason: 'no_api_key' });

  assert.match(status(popup), /sign in/i);
  assert.strictEqual(popup.el('welcome-screen').style.display, 'block');
});

test('Snip still reports its own cancel the same way Capture Now now does', async () => {
  const popup = await openPopup();
  popup.chrome.runtime.sendMessage = (msg, cb) => cb({ ok: false, reason: 'cancelled' });
  popup.el('snip-btn').click();
  await popup.settle();

  assert.match(status(popup), /cancel/i);
});
