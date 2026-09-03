/**
 * #81 — lastActiveAt was written once at account creation and never again.
 * "Last active" showed the join date forever, and the Dashboard's "Active
 * Users Today" tile counted accounts *created* today rather than anyone who
 * had actually used the product.
 *
 * requireAuth now refreshes lastActiveAt on every authenticated request,
 * throttled to once per fifteen minutes so the write doesn't land on every
 * single API call (option 3 of #81, not option 1). The write is
 * fire-and-forget, so these tests poll the emulator rather than trusting the
 * response that triggered it.
 */

'use strict';

const request = require('supertest');
const { FieldValue } = require('firebase-admin/firestore');
const { clearDatabase, seedUser } = require('./helpers/fixtures');

let app, db;

beforeAll(async () => {
  app = require('../src/index').app;
  db  = require('../src/lib/firestore').db;

  await clearDatabase();
});

afterAll(async () => {
  await clearDatabase();
});

/** Poll a user doc until `lastActiveAt` no longer equals `before`, or give up. */
async function waitForStampChange(uid, before, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await db.collection('users').doc(uid).get();
    const after = snap.data().lastActiveAt;
    if (after !== before) return after;
    if (Date.now() >= deadline) return after;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('lastActiveAt — stamped on authenticated requests, throttled', () => {
  test('a stale lastActiveAt is refreshed by an authenticated request', async () => {
    const uid = 'stamp-stale-user';
    const staleTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    await seedUser(uid, { email: 'stamp-stale@test.com', lastActiveAt: staleTimestamp });

    const res = await request(app).get('/me')
      .set('x-dev-user-email', 'stamp-stale@test.com')
      .set('content-type', 'application/json');
    expect(res.status).toBe(200);

    const after = await waitForStampChange(uid, staleTimestamp);
    expect(after).not.toBe(staleTimestamp);
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(staleTimestamp));
  });

  test('a fresh lastActiveAt is left alone — the throttle, not a write on every call', async () => {
    const uid = 'stamp-fresh-user';
    const freshTimestamp = new Date(Date.now() - 60 * 1000).toISOString(); // 1m ago
    await seedUser(uid, { email: 'stamp-fresh@test.com', lastActiveAt: freshTimestamp });

    const res = await request(app).get('/me')
      .set('x-dev-user-email', 'stamp-fresh@test.com')
      .set('content-type', 'application/json');
    expect(res.status).toBe(200);

    // No change expected; give any (wrong) write a moment to land before asserting.
    await new Promise((r) => setTimeout(r, 300));
    const snap = await db.collection('users').doc(uid).get();
    expect(snap.data().lastActiveAt).toBe(freshTimestamp);
  });

  test('a missing lastActiveAt is treated as stale and gets set', async () => {
    const uid = 'stamp-missing-user';
    await seedUser(uid, { email: 'stamp-missing@test.com' });
    await db.collection('users').doc(uid).update({ lastActiveAt: FieldValue.delete() });

    const res = await request(app).get('/me')
      .set('x-dev-user-email', 'stamp-missing@test.com')
      .set('content-type', 'application/json');
    expect(res.status).toBe(200);

    const after = await waitForStampChange(uid, undefined);
    expect(after).toBeTruthy();
  });
});
