'use strict';

// Issue #113 — the Settings panel no longer offers a retention period.
//
// The field looked admin-managed and authoritative: a number, a range, and a
// value the backend reported back. Nothing read it. ADR 0010 fixed the answer
// at "captures are kept indefinitely", so a control that appears to set a
// retention period is telling an Admin something untrue about their data.
//
// The popup-open path is driven for real against a backend that still sends
// the old field, because a deployed backend will keep sending it until it is
// redeployed, and that must not put the value back on screen.
//
// Run with: npm run test:extension

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadPopup } = require('./popup-harness.js');

const EXT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
const js = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');

const TOKEN = 'valid-firebase-id-token';

test('the Settings panel has no retention field', () => {
  assert.ok(!/retention-input/.test(html),
    'popup.html still declares the retention input');
  assert.ok(!/Retention \(days\)/i.test(html),
    'popup.html still labels a retention period');
});

test('the remaining admin-managed field is untouched', () => {
  assert.match(html, /id="max-size-input"/,
    'removing retention must not take the max upload size with it');
});

test('popup.js reads and writes no retention value', () => {
  assert.ok(!/retention/i.test(js),
    'popup.js still mentions retention: ' +
    js.split('\n').filter((l) => /retention/i.test(l)).join('\n'));
});

test('a backend still sending retentionDays does not put it back in storage', async () => {
  const popup = loadPopup({
    local: { settings: { cloudRunUrl: 'https://backend.test', firebaseToken: TOKEN } },
    fetch: async (url) => url.endsWith('/config')
      ? { ok: true, status: 200, json: async () => ({
          retentionDays: 90, retention: 90, maxFileSizeBytes: 10485760,
          maxSize: 10, backendUrl: 'https://backend.test', schemaVersion: 1
        }) }
      : { ok: true, status: 200, json: async () => ({ projects: [], total: 0 }) }
  });

  await popup.fireDOMContentLoaded();
  await popup.settle();

  const stored = popup.local._peek().settings;

  assert.strictEqual(stored.retention, undefined,
    'a stale backend field must not be written into settings');
  assert.strictEqual(stored.retentionDays, undefined);
  assert.strictEqual(stored.maxSize, 10,
    'the fields that remain are still stored');
});
