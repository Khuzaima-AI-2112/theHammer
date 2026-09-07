/**
 * #101, #102, #103 — the Dashboard's tiles count one Workspace
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
 * `capturesToday` joined them in #102, once `uploads` gained a stamped
 * `workspaceId`. It carries one case the other two cannot: a Capture that
 * carries no Workspace at all. Those exist — every Capture written before #102
 * is one until the backfill reaches it — and the guarantee is that they are
 * counted by *nobody* rather than by whoever asks (lesson 67).
 *
 * `pendingReports` was the last, in #103. Every tile on this route is now
 * scoped, which is what closes #98.
 *
 * Offline like the rest of the suite: Firestore is the `demo-hammer` emulator.
 */

'use strict';

const request = require('supertest');
const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const collections = require('../src/lib/collections');
const {
  clearDatabase, seedUser, seedProject, seedCapture, seedReport,
} = require('./helpers/fixtures');

const ALPHA = 'ws-dash-alpha';
const BETA  = 'ws-dash-beta';

const GAMMA = 'ws-dash-gamma';   // a Workspace with nothing in it but its Admin

const ADMIN = { 'x-dev-user-email': 'dash-admin@test.com', 'content-type': 'application/json' };
const STRAY = { 'x-dev-user-email': 'dash-stray@test.com', 'content-type': 'application/json' };
const EMPTY = { 'x-dev-user-email': 'dash-empty@test.com', 'content-type': 'application/json' };

const today     = new Date().toISOString();
const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();

// Alpha's own totals, stated once so a failure reads against a named
// expectation rather than against a number recomputed in the assertion.
const ALPHA_ACTIVE_PROJECTS = 2;   // two with members, one without
const ALPHA_ACTIVE_USERS    = 3;   // the Admin plus two, all active today
const ALPHA_CAPTURES_TODAY  = 2;   // two today, one yesterday, one unstamped
const ALPHA_PENDING_REPORTS = 2;   // one queued, one processing; done and error are not pending

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

  // Captures (#102). Two today, and one the day before so the "today" half of
  // the filter is exercised rather than assumed.
  await seedCapture('dash-alpha-c1', { workspaceId: ALPHA, projectId: 'dash-alpha-p1', uploadedAt: today });
  await seedCapture('dash-alpha-c2', { workspaceId: ALPHA, projectId: 'dash-alpha-p2', uploadedAt: today });
  await seedCapture('dash-alpha-c-old', { workspaceId: ALPHA, projectId: 'dash-alpha-p1', uploadedAt: yesterday });

  // Reports (#103). Both pending statuses are represented, and both settled
  // ones, so the "pending" half of the filter is exercised rather than assumed.
  await seedReport('dash-alpha-r1', { workspaceId: ALPHA, projectId: 'dash-alpha-p1', status: 'queued' });
  await seedReport('dash-alpha-r2', { workspaceId: ALPHA, projectId: 'dash-alpha-p2', status: 'processing' });
  await seedReport('dash-alpha-r-done', { workspaceId: ALPHA, projectId: 'dash-alpha-p1', status: 'done' });
  await seedReport('dash-alpha-r-err', { workspaceId: ALPHA, projectId: 'dash-alpha-p1', status: 'error' });

  // ── Beta: another Customer, deliberately larger ────────────────────
  for (const n of [1, 2, 3, 4]) {
    await seedUser(`dash-beta-u${n}`, {
      email: `b${n}@test.com`, workspaceId: BETA, lastActiveAt: today,
    });
    await seedProject(`dash-beta-p${n}`, { workspaceId: BETA, memberCount: 5 });
    await seedCapture(`dash-beta-c${n}`, {
      workspaceId: BETA, projectId: `dash-beta-p${n}`, uploadedAt: today,
    });
    await seedReport(`dash-beta-r${n}`, {
      workspaceId: BETA, projectId: `dash-beta-p${n}`, status: 'queued',
    });
  }

  // ── Gamma: a real Workspace that simply has no data yet ────────────
  await seedUser('dash-empty-id', {
    email: 'dash-empty@test.com', role: 'admin', workspaceId: GAMMA, lastActiveAt: today,
  });

  // An Admin whose record carries no Workspace at all. Before #7, POST
  // /admin/users wrote users like this; such a record belongs to nobody.
  await seedUser('dash-stray-id', { email: 'dash-stray@test.com', role: 'admin', lastActiveAt: today });
  await db.collection(collections.USERS).doc('dash-stray-id').update({ workspaceId: null });

  // A Monitored User and a Project carrying no Workspace either, so the
  // refusals below are refusing something that genuinely exists.
  await seedUser('dash-orphan-user', { email: 'orphan@test.com', lastActiveAt: today });
  await db.collection(collections.USERS).doc('dash-orphan-user').update({ workspaceId: null });
  await seedProject('dash-orphan-project', { memberCount: 3 });
  await db.collection(collections.PROJECTS).doc('dash-orphan-project').update({ workspaceId: null });

  // A Capture written before #102 stamped the field: it is filed against one of
  // Alpha's own Projects and was taken today, so the *only* thing keeping it out
  // of Alpha's count is the missing stamp. That is the point — it is what the
  // backfill exists to repair, and until then it belongs to nobody.
  await seedCapture('dash-orphan-capture', { projectId: 'dash-alpha-p1', uploadedAt: today });
  await db.collection(collections.UPLOADS).doc('dash-orphan-capture').update({ workspaceId: null });

  // The same, for a Report (#103): queued, filed against one of Alpha's own
  // Projects, and unstamped.
  await seedReport('dash-orphan-report', { projectId: 'dash-alpha-p1', status: 'queued' });
  await db.collection(collections.REPORTS).doc('dash-orphan-report').update({ workspaceId: null });
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

  test('capturesToday counts the caller\'s Workspace, and is not zero', async () => {
    const res = await request(app).get('/admin/dashboard/stats').set(ADMIN);

    expect(res.status).toBe(200);
    expect(res.body.capturesToday).toBe(ALPHA_CAPTURES_TODAY);
    expect(res.body.capturesToday).toBeGreaterThan(0);
  });

  // Absent means nobody, not everybody (lesson 67). The unstamped Capture is in
  // one of Alpha's Projects and was taken today, so a query that treated a
  // missing stamp as a match — or that scoped by Project id instead — would
  // count it and this number would be one higher.
  test('a Capture carrying no Workspace is counted by nobody', async () => {
    const res = await request(app).get('/admin/dashboard/stats').set(ADMIN);

    const unstamped = await db.collection(collections.UPLOADS)
      .where('workspaceId', '==', null).count().get();

    expect(unstamped.data().count).toBeGreaterThan(0);   // it really is there
    expect(res.body.capturesToday).toBe(ALPHA_CAPTURES_TODAY);
  });

  test('pendingReports counts the caller\'s Workspace, and is not zero', async () => {
    const res = await request(app).get('/admin/dashboard/stats').set(ADMIN);

    expect(res.status).toBe(200);
    expect(res.body.pendingReports).toBe(ALPHA_PENDING_REPORTS);
    expect(res.body.pendingReports).toBeGreaterThan(0);
  });

  test('a Report carrying no Workspace is counted by nobody', async () => {
    const res = await request(app).get('/admin/dashboard/stats').set(ADMIN);

    const unstamped = await db.collection(collections.REPORTS)
      .where('workspaceId', '==', null).count().get();

    expect(unstamped.data().count).toBeGreaterThan(0);   // it really is there
    expect(res.body.pendingReports).toBe(ALPHA_PENDING_REPORTS);
  });

  // The assertion that would fail on the pre-#101/#102/#103 code: Beta has more
  // of all four than Alpha does, so an unscoped count cannot accidentally equal
  // the right answer.
  test('no tile counts the other Customer', async () => {
    const res = await request(app).get('/admin/dashboard/stats').set(ADMIN);

    const betaProjects = await db.collection(collections.PROJECTS)
      .where('workspaceId', '==', BETA).count().get();
    const betaUsers = await db.collection(collections.USERS)
      .where('workspaceId', '==', BETA).count().get();
    const betaCaptures = await db.collection(collections.UPLOADS)
      .where('workspaceId', '==', BETA).count().get();
    const betaReports = await db.collection(collections.REPORTS)
      .where('workspaceId', '==', BETA).count().get();

    expect(betaProjects.data().count).toBeGreaterThan(res.body.activeProjects);
    expect(betaUsers.data().count).toBeGreaterThan(res.body.activeUsersToday);
    expect(betaCaptures.data().count).toBeGreaterThan(res.body.capturesToday);
    expect(betaReports.data().count).toBeGreaterThan(res.body.pendingReports);
  });

  test('an Admin carrying no Workspace is refused, not answered', async () => {
    const res = await request(app).get('/admin/dashboard/stats').set(STRAY);

    expect(res.status).toBe(403);
    expect(res.body.activeProjects).toBeUndefined();
  });

  // The criterion that is easiest to assume and cheapest to break: a count()
  // over an empty result set returns 0 rather than throwing, but a later
  // "no rows, must be a bad Workspace" guard would turn this into a refusal.
  test('an Admin in a Workspace with no data gets zeroes, not an error', async () => {
    const res = await request(app).get('/admin/dashboard/stats').set(EMPTY);

    expect(res.status).toBe(200);
    expect(res.body.activeProjects).toBe(0);
    expect(res.body.activeUsersToday).toBe(1); // only themselves
    expect(res.body.capturesToday).toBe(0);
    expect(res.body.pendingReports).toBe(0);
  });
});

// The guard above is shared with two routes that had no guard at all, and were
// leaking because of it. `where('workspaceId', '==', null)` does not match
// nothing — it matches every record that carries no Workspace, which since #7
// means every record that belongs to nobody. An Admin with no Workspace was
// therefore answered with all of them.
//
// These live here rather than in workspace-isolation.test.js because the caller
// is not in another Workspace; they are in none, which is a different thing and
// was the hole.
describe('a Workspace-less Admin is refused by the routes that scope by their Workspace', () => {
  test('GET /admin/users does not answer with the unstamped roster', async () => {
    const res = await request(app).get('/admin/users').set(STRAY);

    expect(res.status).toBe(403);
    expect(res.body.users).toBeUndefined();
  });

  test('GET /admin/projects does not answer with unstamped Projects', async () => {
    const res = await request(app).get('/admin/projects').set(STRAY);

    expect(res.status).toBe(403);
    expect(res.body.projects).toBeUndefined();
  });

  test('the unstamped records really exist, so the refusals are not vacuous', async () => {
    const orphanUsers = await db.collection(collections.USERS)
      .where('workspaceId', '==', null).count().get();
    const orphanProjects = await db.collection(collections.PROJECTS)
      .where('workspaceId', '==', null).count().get();

    expect(orphanUsers.data().count).toBeGreaterThan(0);
    expect(orphanProjects.data().count).toBeGreaterThan(0);
  });
});
