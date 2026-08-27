/**
 * Issue #4  —  Firebase ID token is the only authentication path
 *
 * The rest of the suite authenticates through the `x-dev-user-email` fallback
 * in requireAuth, which is disabled in production. Nothing exercised the real
 * Bearer-token branch, so removing the API key surface could not be shown to
 * have left production auth intact. This file covers that branch by mocking
 * only the token verifier — the Firestore lookup, role check and response all
 * run for real against the emulator.
 */

'use strict';

// Name must start with "mock": jest.mock() factories are hoisted above the
// file body and may only reference variables matching that prefix.
const mockVerifyIdToken = jest.fn();

// Mocked before the app is required so requireAuth closes over this stub.
jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken: mockVerifyIdToken }),
}));

const request = require('supertest');
const { clearDatabase, seedUser } = require('./helpers/fixtures');

let app, db;

const UID = 'firebase-uid-token-user';

beforeAll(async () => {
  app = require('../src/index').app;
  db = require('../src/lib/firestore').db;

  await clearDatabase();
  await seedUser(UID, { email: 'token-user@test.com', role: 'user' });
});

afterAll(async () => {
  await clearDatabase();
});

beforeEach(() => {
  mockVerifyIdToken.mockReset();
});

describe('GET /me — authentication via Firebase ID token', () => {
  test('200 — a verified token resolves the caller from Firestore', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: UID, email: 'token-user@test.com' });

    const res = await request(app).get('/me')
      .set('Authorization', 'Bearer good-token');

    expect(mockVerifyIdToken).toHaveBeenCalledWith('good-token');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(UID);
    expect(res.body.email).toBe('token-user@test.com');
    expect(res.body.role).toBe('user');
  });

  test('401 — a token the verifier rejects is refused', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('Firebase ID token has expired'));

    const res = await request(app).get('/me')
      .set('Authorization', 'Bearer expired-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unauthenticated/);
  });

  test('403 — a verified token for a user absent from Firestore is not provisioned', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'stranger-uid', email: 'stranger@test.com' });

    const res = await request(app).get('/me')
      .set('Authorization', 'Bearer stranger-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not provisioned');
  });

  test('401 — no Authorization header and no dev fallback header', async () => {
    const res = await request(app).get('/me');

    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing Bearer token/);
  });
});
