/**
 * Issue #33  —  the bootstrap loop
 *
 * Every route that writes a `users` document sat behind a guard that required
 * one to already exist, so the collection could never gain a first record.
 * `POST /admin/workspaces` is the intended path to the first administrator and
 * `POST /admin/workspaces/join` is how an invited user gets a record; both were
 * unreachable by exactly the newly signed-up user their own comments described.
 *
 * These routes had no tests at all, which is how a guard could contradict the
 * comment directly above it and stay that way. The suite covers both the fix
 * and its blast radius: the relaxation must reach these two routes and nothing
 * else, so `GET /me` and the admin-only invite routes are asserted to still
 * refuse an unprovisioned caller.
 *
 * Only the token verifier is mocked. The Firestore writes, the invite matching
 * and the expiry check all run for real against the emulator.
 */

'use strict';

// Name must start with "mock": jest.mock() factories are hoisted above the
// file body and may only reference variables matching that prefix.
const mockVerifyIdToken = jest.fn();

jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken: mockVerifyIdToken }),
}));

const request = require('supertest');
const { clearDatabase, seedUser } = require('./helpers/fixtures');
const collections = require('../src/lib/collections');
const { USER_PREFERENCES } = require('../src/lib/defaults');

let app, db;

const BOOTSTRAP_EMAIL = 'founder@hammer.test';
const BOOTSTRAP_UID   = 'firebase-uid-founder';

/** Authenticate as whoever, without needing them to exist in Firestore. */
const asToken = (uid, email) => {
  mockVerifyIdToken.mockResolvedValue({ uid, email });
  return { Authorization: 'Bearer any-token', 'content-type': 'application/json' };
};

async function seedInvite(overrides = {}) {
  const invite = {
    workspaceId: 'ws-existing',
    email: 'invitee@hammer.test',
    role: 'user',
    token: 'invite-token-abc',
    invitedBy: 'someone',
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    ...overrides,
  };
  const ref = await db.collection(collections.INVITATIONS).add(invite);
  return { ref, invite };
}

const userDoc = (uid) => db.collection(collections.USERS).doc(uid).get();

beforeAll(() => {
  app = require('../src/index').app;
  db = require('../src/lib/firestore').db;
});

beforeEach(async () => {
  mockVerifyIdToken.mockReset();
  await clearDatabase();
  process.env.BOOTSTRAP_ADMIN_EMAIL = BOOTSTRAP_EMAIL;
});

afterAll(async () => {
  delete process.env.BOOTSTRAP_ADMIN_EMAIL;
  await clearDatabase();
});

// ───────────────────────────────────────────────────────────────────
describe('POST /admin/workspaces — creating the first administrator', () => {
  test('401 — no Bearer token', async () => {
    const res = await request(app).post('/admin/workspaces').send({ name: 'Hammer' });

    expect(res.status).toBe(401);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  test('401 — the verifier rejects the token', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('Firebase ID token has expired'));

    const res = await request(app).post('/admin/workspaces')
      .set({ Authorization: 'Bearer expired' })
      .send({ name: 'Hammer' });

    expect(res.status).toBe(401);
  });

  test('403 — BOOTSTRAP_ADMIN_EMAIL unset denies everyone', async () => {
    delete process.env.BOOTSTRAP_ADMIN_EMAIL;

    const res = await request(app).post('/admin/workspaces')
      .set(asToken(BOOTSTRAP_UID, BOOTSTRAP_EMAIL))
      .send({ name: 'Hammer' });

    expect(res.status).toBe(403);
    expect((await userDoc(BOOTSTRAP_UID)).exists).toBe(false);
  });

  test('403 — a verified token that is not the bootstrap address', async () => {
    const res = await request(app).post('/admin/workspaces')
      .set(asToken('firebase-uid-stranger', 'stranger@hammer.test'))
      .send({ name: 'Hammer' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/invitation only/);
    expect((await userDoc('firebase-uid-stranger')).exists).toBe(false);
  });

  test('403 — matching is case-insensitive but not fuzzy', async () => {
    const res = await request(app).post('/admin/workspaces')
      .set(asToken(BOOTSTRAP_UID, `not-${BOOTSTRAP_EMAIL}`))
      .send({ name: 'Hammer' });

    expect(res.status).toBe(403);
  });

  test('201 — the bootstrap address creates the workspace and its admin', async () => {
    const res = await request(app).post('/admin/workspaces')
      .set(asToken(BOOTSTRAP_UID, BOOTSTRAP_EMAIL.toUpperCase()))
      .send({ name: 'The Hammer' });

    expect(res.status).toBe(201);
    expect(res.body.ownerId).toBe(BOOTSTRAP_UID);

    // The regression this issue is about: a users document now exists.
    const snap = await userDoc(BOOTSTRAP_UID);
    expect(snap.exists).toBe(true);

    const d = snap.data();
    expect(d.role).toBe('admin');
    expect(d.email).toBe(BOOTSTRAP_EMAIL);          // normalised, despite the shouting
    expect(d.workspaceId).toBe(res.body.id);

    // A complete record, not the three fields the workspace itself needed.
    expect(d.createdAt).toBeTruthy();
    expect(d.lastActiveAt).toBeTruthy();
    expect(d.schemaVersion).toBe(1);
    expect(d.displayName).toBeNull();
    expect(d.inactivityTimerSeconds).toBe(USER_PREFERENCES.inactivityTimerSeconds);
  });

  test('the bootstrapped admin can then reach an admin-only route', async () => {
    await request(app).post('/admin/workspaces')
      .set(asToken(BOOTSTRAP_UID, BOOTSTRAP_EMAIL))
      .send({ name: 'The Hammer' });

    const res = await request(app).post('/admin/workspaces/invites')
      .set(asToken(BOOTSTRAP_UID, BOOTSTRAP_EMAIL))
      .send({ email: 'colleague@hammer.test', role: 'user' });

    expect(res.status).toBe(201);
  });

  test('400 — a second workspace for the same owner', async () => {
    const headers = asToken(BOOTSTRAP_UID, BOOTSTRAP_EMAIL);
    await request(app).post('/admin/workspaces').set(headers).send({ name: 'First' });

    const res = await request(app).post('/admin/workspaces').set(headers).send({ name: 'Second' });

    expect(res.status).toBe(400);
  });

  test('400 — a missing workspace name is still rejected', async () => {
    const res = await request(app).post('/admin/workspaces')
      .set(asToken(BOOTSTRAP_UID, BOOTSTRAP_EMAIL))
      .send({});

    expect(res.status).toBe(400);
  });
});

// ───────────────────────────────────────────────────────────────────
describe('POST /admin/workspaces/join — accepting an invitation', () => {
  test('401 — no Bearer token', async () => {
    const res = await request(app).post('/admin/workspaces/join').send({ token: 'x' });

    expect(res.status).toBe(401);
  });

  test('200 — an invited user with no users document gets one', async () => {
    const { ref, invite } = await seedInvite({ role: 'analyst' });

    const res = await request(app).post('/admin/workspaces/join')
      .set(asToken('firebase-uid-invitee', invite.email))
      .send({ token: invite.token });

    expect(res.status).toBe(200);
    expect(res.body.workspaceId).toBe(invite.workspaceId);

    // The record the old guard made impossible to create.
    const snap = await userDoc('firebase-uid-invitee');
    expect(snap.exists).toBe(true);
    expect(snap.data().role).toBe('analyst');
    expect(snap.data().workspaceId).toBe(invite.workspaceId);
    expect(snap.data().schemaVersion).toBe(1);

    expect((await ref.get()).data().status).toBe('claimed');
  });

  test('an existing user joining another workspace keeps their createdAt', async () => {
    const CREATED = '2020-01-01T00:00:00.000Z';
    await seedUser('firebase-uid-veteran', {
      email: 'veteran@hammer.test',
      role: 'user',
      createdAt: CREATED,
      workspaceId: 'ws-old',
    });
    const { invite } = await seedInvite({ email: 'veteran@hammer.test', role: 'admin', workspaceId: 'ws-new' });

    const res = await request(app).post('/admin/workspaces/join')
      .set(asToken('firebase-uid-veteran', 'veteran@hammer.test'))
      .send({ token: invite.token });

    expect(res.status).toBe(200);

    const d = (await userDoc('firebase-uid-veteran')).data();
    expect(d.createdAt).toBe(CREATED);       // not clobbered
    expect(d.workspaceId).toBe('ws-new');    // but the move took effect
    expect(d.role).toBe('admin');
  });

  test('400 — an invitation addressed to somebody else', async () => {
    const { invite } = await seedInvite();

    const res = await request(app).post('/admin/workspaces/join')
      .set(asToken('firebase-uid-gatecrasher', 'gatecrasher@hammer.test'))
      .send({ token: invite.token });

    expect(res.status).toBe(400);
    expect((await userDoc('firebase-uid-gatecrasher')).exists).toBe(false);
  });

  test('400 — an expired invitation', async () => {
    const { invite } = await seedInvite({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const res = await request(app).post('/admin/workspaces/join')
      .set(asToken('firebase-uid-invitee', invite.email))
      .send({ token: invite.token });

    expect(res.status).toBe(400);
    expect((await userDoc('firebase-uid-invitee')).exists).toBe(false);
  });

  test('400 — a token nobody issued', async () => {
    const res = await request(app).post('/admin/workspaces/join')
      .set(asToken('firebase-uid-invitee', 'invitee@hammer.test'))
      .send({ token: 'not-a-real-token' });

    expect(res.status).toBe(400);
  });

  test('400 — an invitation that has already been claimed', async () => {
    const { invite } = await seedInvite({ status: 'claimed' });

    const res = await request(app).post('/admin/workspaces/join')
      .set(asToken('firebase-uid-invitee', invite.email))
      .send({ token: invite.token });

    expect(res.status).toBe(400);
  });

  test('400 — no invite token in the body', async () => {
    const res = await request(app).post('/admin/workspaces/join')
      .set(asToken('firebase-uid-invitee', 'invitee@hammer.test'))
      .send({});

    expect(res.status).toBe(400);
  });
});

// ───────────────────────────────────────────────────────────────────
describe('the relaxation reaches those two routes and nothing else', () => {
  test('GET /me still refuses a verified token with no users document', async () => {
    const res = await request(app).get('/me').set(asToken('firebase-uid-stranger', 'stranger@hammer.test'));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not provisioned');
  });

  test('POST /admin/workspaces/invites still requires a provisioned admin', async () => {
    const res = await request(app).post('/admin/workspaces/invites')
      .set(asToken('firebase-uid-stranger', 'stranger@hammer.test'))
      .send({ email: 'x@hammer.test', role: 'user' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not provisioned');
  });

  test('GET /admin/workspaces/invites still requires a provisioned admin', async () => {
    const res = await request(app).get('/admin/workspaces/invites')
      .set(asToken('firebase-uid-stranger', 'stranger@hammer.test'));

    expect(res.status).toBe(403);
  });

  test('a provisioned non-admin cannot create a workspace either', async () => {
    await seedUser('firebase-uid-member', { email: 'member@hammer.test', role: 'user' });

    const res = await request(app).post('/admin/workspaces')
      .set(asToken('firebase-uid-member', 'member@hammer.test'))
      .send({ name: 'Rogue workspace' });

    expect(res.status).toBe(403);
  });
});
