/**
 * #81 — lastActiveAt is stamped in both of requireAuth's success paths, and
 * they resolve the user doc differently (userDoc from `.doc(uid).get()`
 * versus the query-by-email fallback's `snap.docs[0]`). last-active-stamp.test.js
 * covers the x-dev-user-email path; this file covers the real Bearer-token
 * path the same way auth.firebase-token.test.js does — mocking only the
 * token verifier, before the app is required, so requireAuth closes over it.
 */

'use strict';

const mockVerifyIdToken = jest.fn();

jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken: mockVerifyIdToken }),
}));

const request = require('supertest');
const { clearDatabase, seedUser } = require('./helpers/fixtures');

let app, db;

const UID = 'stamp-token-user';

beforeAll(async () => {
  app = require('../src/index').app;
  db  = require('../src/lib/firestore').db;

  await clearDatabase();
});

afterAll(async () => {
  await clearDatabase();
});

beforeEach(() => {
  mockVerifyIdToken.mockReset();
});

test('a verified Bearer token also refreshes a stale lastActiveAt', async () => {
  const staleTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
  await seedUser(UID, { email: 'stamp-token@test.com', lastActiveAt: staleTimestamp });
  mockVerifyIdToken.mockResolvedValue({ uid: UID, email: 'stamp-token@test.com' });

  const res = await request(app).get('/me').set('Authorization', 'Bearer good-token');
  expect(res.status).toBe(200);

  const deadline = Date.now() + 3000;
  let after = staleTimestamp;
  while (Date.now() < deadline) {
    const snap = await db.collection('users').doc(UID).get();
    after = snap.data().lastActiveAt;
    if (after !== staleTimestamp) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(after).not.toBe(staleTimestamp);
  expect(Date.parse(after)).toBeGreaterThan(Date.parse(staleTimestamp));
});
