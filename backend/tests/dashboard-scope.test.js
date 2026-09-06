/**
 * #101 — the Dashboard's Project and user tiles count one Workspace
 *
 * `GET /admin/dashboard/stats` counted five collections across the whole
 * database and scoped none of them, so every Admin saw every Customer's
 * numbers: how many Projects a competitor runs, and how much work their staff
 * did today. #100 removed the tile that counted nothing; this file covers the
 * two tiles that need no schema change, because `projects` and `users` already
 * carry a `workspaceId`.
 *
 * Same class of leak as #7's four, but aggregate-shaped: those cases each assert
 * a refusal, and this route has nothing to refuse. It answers a caller entitled
 * to a number, and the number was computed over the wrong rows. So every case
 * here asserts a *count* — and asserts it twice over.
 *
 * **Each tile is asserted to equal the caller's own total AND to be non-zero.**
 * That pairing is the point. A query scoped to a Workspace that returns nothing
 * at all would satisfy "excludes Beta" perfectly, and an over-counting bug would
 * become an under-counting one with the suite still green. Beta is always seeded
 * with *more* rows than Alpha, so a leak reads as a wrong number rather than as
 * a coincidence.
 *
 * `capturesToday` and `pendingReports` are deliberately not asserted here. They
 * are still unscoped until #102 and #103 stamp their collections, and writing a
 * passing test against the leaked number would be worse than writing none.
 *
 * Offline like the rest of the suite: Firestore is the `demo-hammer` emulator.
 */

'use strict';

const request = require('supertest');
const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const collections = require('../src/lib/collections');
const { clearDatabase, seedUser, seedProject } = require('./helpers/fixtures');

const ALPHA = 'ws-dash-alpha';
const BETA  = 'ws-dash-beta';

const ADMIN = { 'x-dev-user-email': 'dash-admin@test.com', 'content-type': 'application/json' };
const STRAY = { 'x-dev-user-email': 'dash-stray@test.com', 'content-type': 'application/json' };

const today     = new Date().toISOString();
const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();

// Alpha's own totals, stated once so a failure reads against a named
// expectation rather than against a number recomputed in the assertion.
const ALPHA_ACTIVE_PROJECTS = 2;   // two with members, one without
const ALPHA_ACTIVE_USERS    = 3;   // the Admin plus two, all active today

beforeAll(async () => {
  await clearDatabase();

  // ── Alpha: the caller's Workspace ──────────────────────────────────
  await seedUser('dash-admin-id', {
    email: 'dash-admin@test.com', role: 'admin', workspaceId: ALPHA, lastActiveAt: today,
  });
  await seedUser('dash-alpha-1', { email: 'a1@test.com', workspaceId: ALPHA, lastActiveAt: today });
  await seedUser('dash-alpha-2', { email: 'a2@test.com', workspaceId: ALPHA, lastActiveAt: today });
  // Idle since the day before, so the "today" half of the filter is exercised
  // rather than assumed — without this, a query that dropped the date filter
  // would still pass.
  await seedUser('dash-alpha-idle', { email: 'a3@test.com', workspaceId: ALPHA, lastActiveAt: yesterday });

  await seedProject('dash-alpha-p1', { workspaceId: ALPHA, memberCount: 2 });
  await seedProject('dash-alpha-p2', { workspaceId: ALPHA, memberCount: 1 });
  // No members, so the "active" half of the filter is exercised too.
  await seedProject('dash-alpha-p3', { workspaceId: ALPHA, memberCount: 0 });

  // ── Beta: another Customer, deliberately larger ────────────────────
  for (const n of [1, 2, 3, 4]) {
    await seedUser(`dash-beta-u${n}`, {
      email: `b${n}@test.com`, workspaceId: BETA, lastActiveAt: today,
    });
    await seedProject(`dash-beta-p${n}`, { workspaceId: BETA, memberCount: 5 });
  }

  // An Admin whose record carries no Workspace at all. Before #7, POST
  // /admin/users wrote users like this; such a record belongs to nobody.
  await seedUser('dash-stray-id', { email: 'dash-stray@test.com', role: 'admin', lastActiveAt: today });
  await db.collection(collections.USERS).doc('dash-stray-id').update({ workspaceId: null });
});

afterAll(async () => {
  await clearDatabase();
});

describe('GET /admin/dashboard/stats — the Project and user tiles are scoped', () => {
  test('activeProjects counts the caller\'s Workspace, and is not zero', async () => {
    const res = await request(app).get('/admin/dashboard/stats').set(ADMIN);

    expect(res.status).toBe(200);
    expect(res.body.activeProjects).toBe(ALPHA_ACTIVE_PROJECTS);
    expect(res.body.activeProjects).toBeGreaterThan(0);
  });

  test('activeUsersToday counts the caller\'s Workspace, and is not zero', async () => {
    const res = await request(app).get('/admin/dashboard/stats').set(ADMIN);

    expect(res.status).toBe(200);
    expect(res.body.activeUsersToday).toBe(ALPHA_ACTIVE_USERS);
    expect(res.body.activeUsersToday).toBeGreaterThan(0);
  });

  // The assertion that would fail on the pre-#101 code: Beta has more of both
  // than Alpha does, so an unscoped count cannot accidentally equal the right
  // answer.
  test('neither tile counts the other Customer', async () => {
    const res = await request(app).get('/admin/dashboard/stats').set(ADMIN);

    const betaProjects = await db.collection(collections.PROJECTS)
      .where('workspaceId', '==', BETA).count().get();
    const betaUsers = await db.collection(collections.USERS)
      .where('workspaceId', '==', BETA).count().get();

    expect(betaProjects.data().count).toBeGreaterThan(res.body.activeProjects);
    expect(betaUsers.data().count).toBeGreaterThan(res.body.activeUsersToday);
  });

  test('an Admin carrying no Workspace is refused, not answered', async () => {
    const res = await request(app).get('/admin/dashboard/stats').set(STRAY);

    expect(res.status).toBe(403);
    expect(res.body.activeProjects).toBeUndefined();
  });
});
