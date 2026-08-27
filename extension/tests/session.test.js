'use strict';

// Session boundaries — ADR-0007 and issue #17.
//
// Run with: node --test extension/tests/

const test = require('node:test');
const assert = require('node:assert');
const { loadServiceWorker, sessionEvents } = require('./sw-harness.js');

const SETTINGS = {
  settings: { cloudRunUrl: 'https://api.test/api', firebaseToken: 'test-token' }
};

const boot = (opts = {}) => loadServiceWorker({ local: SETTINGS, ...opts });

test('a project change writes the outgoing Session down before replacing it', async () => {
  const sw = boot();

  await sw.sessionOnCapture('proj-a', 'a/1.png');
  await sw.sessionOnCapture('proj-a', 'a/2.png');
  const b = await sw.sessionOnCapture('proj-b', 'b/1.png');

  const events = sessionEvents(sw.requests);
  assert.strictEqual(events.length, 1, 'the outgoing Session should have been flushed exactly once');

  const [flushed] = events;
  assert.strictEqual(flushed.projectId, 'proj-a', 'the document carries the outgoing project, not the incoming one');
  assert.strictEqual(flushed.totalCaptures, 2, 'it counts only the captures made against proj-a');
  assert.strictEqual(flushed.firstCapturePath, 'a/1.png');
  assert.strictEqual(flushed.lastCapturePath, 'a/2.png');
  assert.strictEqual(flushed.flushReason, 'project_changed');
  assert.ok(Date.parse(flushed.sessionEnd) >= Date.parse(flushed.sessionStart), 'sessionEnd is set and not before the start');

  assert.strictEqual(b.isFirstInSession, true, 'the capture against proj-b opens a new Session');
  assert.notStrictEqual(b.sessionId, flushed.sessionId, 'the new Session has its own id');

  const current = await sw.sessionGet();
  assert.strictEqual(current.projectId, 'proj-b');
  assert.strictEqual(current.totalCaptures, 1);
  assert.strictEqual(current.firstCapturePath, 'b/1.png');
  assert.strictEqual(current.flushed, false);
});

test('captures either side of a project change produce two documents, one per project', async () => {
  const sw = boot();

  await sw.sessionOnCapture('proj-a', 'a/1.png');
  await sw.sessionOnCapture('proj-b', 'b/1.png');
  await sw.sessionFlush('window_removed');

  const events = sessionEvents(sw.requests);
  assert.strictEqual(events.length, 2);
  assert.deepStrictEqual(events.map((e) => e.projectId), ['proj-a', 'proj-b']);
  assert.notStrictEqual(events[0].sessionId, events[1].sessionId);
  assert.strictEqual(events[0].totalCaptures, 1);
  assert.strictEqual(events[1].totalCaptures, 1);
});

test('switching project and straight back without capturing leaves one Session', async () => {
  const sw = boot();

  const first = await sw.sessionOnCapture('proj-a', 'a/1.png');

  // The person switches the popup over to proj-b and back again. Nothing is
  // captured while proj-b is selected, so the service worker never hears about
  // it — which is the whole mechanism ADR-0007 relies on.
  await sw.chrome.storage.local.set({ session: { projectId: 'proj-b' } });
  await sw.chrome.storage.local.set({ session: { projectId: 'proj-a' } });

  const second = await sw.sessionOnCapture('proj-a', 'a/2.png');

  assert.strictEqual(sessionEvents(sw.requests).length, 0, 'nothing was flushed, so no Session ended');
  assert.strictEqual(second.sessionId, first.sessionId, 'it is still the same Session');
  assert.strictEqual(second.isFirstInSession, false);

  const current = await sw.sessionGet();
  assert.strictEqual(current.totalCaptures, 2, 'both captures counted against the one Session');
});

test('the existing flush paths still write once and stay idempotent', async () => {
  const sw = boot();

  await sw.sessionOnCapture('proj-a', 'a/1.png');

  assert.strictEqual(await sw.sessionFlush('suspend'), true);
  assert.strictEqual(await sw.sessionFlush('window_removed'), false, 'the flushed flag blocks the second write');
  assert.strictEqual(sessionEvents(sw.requests).length, 1);
  assert.strictEqual(sessionEvents(sw.requests)[0].flushReason, 'suspend');
});

test('a Session already flushed by suspend still rotates on the next capture', async () => {
  const sw = boot();

  await sw.sessionOnCapture('proj-a', 'a/1.png');
  await sw.sessionFlush('suspend');
  const next = await sw.sessionOnCapture('proj-a', 'a/2.png');

  assert.strictEqual(next.isFirstInSession, true, 'the flushed Session is not resumed');
  assert.strictEqual(sessionEvents(sw.requests).length, 1, 'and it is not written a second time');
});

test('a failed flush at a boundary is loud, and never blocks the capture', async () => {
  const sw = boot({ fetch: async () => { throw new Error('offline'); } });

  await sw.sessionOnCapture('proj-a', 'a/1.png');
  const b = await sw.sessionOnCapture('proj-b', 'b/1.png');

  assert.strictEqual(b.isFirstInSession, true, 'the capture against proj-b proceeds regardless');
  const current = await sw.sessionGet();
  assert.strictEqual(current.projectId, 'proj-b');
  assert.ok(
    sw.logs.error.some((line) => line.includes('its time is lost')),
    'the lost Session is reported rather than swallowed'
  );
});

test('the badge announces a new Session at the boundary and clears on the next capture', async () => {
  const sw = boot();

  await sw.sessionOnCapture('proj-a', 'a/1.png');
  assert.strictEqual(sw.badge.text, '', 'the first Session of the day is not a project change');

  await sw.sessionOnCapture('proj-b', 'b/1.png');
  assert.strictEqual(sw.badge.text, 'NEW');
  assert.match(sw.badge.title, /new session started for proj-b/);

  await sw.sessionOnCapture('proj-b', 'b/2.png');
  assert.strictEqual(sw.badge.text, '', 'the announcement does not linger');
  assert.match(sw.badge.title, /session running on proj-b/);
});
