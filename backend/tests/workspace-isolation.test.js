/**
 * #7 — Workspace isolation (SEC-01 … SEC-12)
 *
 * A Workspace is one Customer's isolated tenant, and it is the boundary the
 * whole multi-Customer model rests on. Until this file existed the suite had
 * no case that crossed it: every test authenticated inside the one Workspace
 * its own fixtures created, so a route that had forgotten to check ownership
 * looked exactly like one that checked it.
 *
 * Twelve cases, each one a caller in Workspace Alpha reaching for something
 * that belongs to Workspace Beta. Every case asserts a *refusal* — a 403 (or
 * a 404 where the route cannot distinguish a foreign id from a deleted one) —
 * and every case that could write also asserts Beta's data is unchanged
 * afterwards. That combination is deliberate: a route that silently returned
 * an empty list, or that wrote nothing because of an unrelated validation
 * error, would pass a weaker assertion while the scope leak stayed open.
 *
 * Naming: `SEC-07` also appears in tests/capture.upload-guard.test.js, from an
 * earlier and unrelated numbering. The ids here are #7's SEC-01 … SEC-12 and
 * mean workspace isolation; the collision is noted rather than resolved,
 * because renaming a passing suite is not this ticket's work.
 *
 * Offline like the rest of the suite: Firestore is the `demo-hammer` emulator
 * (tests/setup/env.js) and Cloud Storage is the shared double.
 */

'use strict';

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock({
  signedUrlPrefix: 'https://storage.googleapis.com/fake-bucket/'
}));

process.env.GCS_BUCKET = 'fake-bucket';

const request = require('supertest');
const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const collections = require('../src/lib/collections');
const { clearDatabase, seedUser, seedProject, seedMembership } = require('./helpers/fixtures');

const ALPHA = 'ws-alpha';
const BETA  = 'ws-beta';

// Callers. All three live in Alpha; there is deliberately no Beta caller, as
// nothing here tests what Beta can do — only what Alpha cannot reach.
const ADMIN   = { 'x-dev-user-email': 'iso-admin@test.com',   'content-type': 'application/json' };
const ANALYST = { 'x-dev-user-email': 'iso-analyst@test.com', 'content-type': 'application/json' };
const USER    = { 'x-dev-user-email': 'iso-user@test.com' };

// Beta's data. Named for what it is so a failure reads as "Alpha reached
// Beta's Project", not as "the third fixture came back".
const BETA_PROJECT    = 'beta-project';
const BETA_USER       = 'beta-monitored-user';
const BETA_MEMBERSHIP = `${BETA_PROJECT}_${BETA_USER}`;
const BETA_REPORT     = 'beta-report';
const ALPHA_PROJECT   = 'alpha-project';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/**
 * Every refusal in this file is one of these two, and never a 2xx.
 *
 * #99 narrowed what a foreign *Project* answers to 403 alone: unknown and
 * foreign are now one answer, so nothing here can tell them apart. 404 is still
 * accepted because a foreign Storyboard draft or report id is refused by a
 * route that looks the record up by a different collection first.
 */
function expectRefused(res) {
  expect([403, 404]).toContain(res.status);
}

beforeAll(async () => {
  await clearDatabase();

  await seedUser('iso-admin-id',   { email: 'iso-admin@test.com',   role: 'admin',   workspaceId: ALPHA });
  await seedUser('iso-analyst-id', { email: 'iso-analyst@test.com', role: 'analyst', workspaceId: ALPHA });
  await seedUser('iso-user-id',    { email: 'iso-user@test.com',    role: 'user',    workspaceId: ALPHA });
  await seedProject(ALPHA_PROJECT, { name: 'Alpha work', workspaceId: ALPHA });

  await seedUser(BETA_USER, {
    email: 'beta-monitored@test.com',
    displayName: 'Beta Monitored User',
    role: 'user',
    workspaceId: BETA,
  });
  await seedProject(BETA_PROJECT, { name: 'Beta work', workspaceId: BETA, memberCount: 1 });
  await seedMembership(BETA_PROJECT, BETA_USER);

  await db.collection(collections.UPLOADS).doc('beta-capture-1').set({
    projectId: BETA_PROJECT,
    userId: BETA_USER,
    tool: 'Softomedia',
    path: `${BETA_PROJECT}/beta-capture-1.png`,
    bucket: 'fake-bucket',
    size: 1234,
    uploadedAt: new Date('2026-09-01T10:00:00.000Z').toISOString(),
    schemaVersion: 1,
  });

  await db.collection(collections.REPORTS).doc(BETA_REPORT).set({
    projectId: BETA_PROJECT,
    reportType: 'project_progress',
    status: 'complete',
    gcsPath: `reports/${BETA_REPORT}.pdf`,
    createdAt: new Date('2026-09-01T12:00:00.000Z').toISOString(),
    schemaVersion: 1,
  });
});

afterAll(async () => {
  await clearDatabase();
});

// ── The suite cannot reach the live project ──────────────────────────
// Acceptance criterion of #7, asserted rather than assumed. Everything below
// writes to Firestore as an authenticated caller; if the emulator variable
// were ever unset, those writes would be aimed at a real project instead.

describe('offline guarantee', () => {
  test('Firestore is the emulator, on the demo-hammer project', () => {
    expect(process.env.FIRESTORE_EMULATOR_HOST).toBeTruthy();
    expect(process.env.GCLOUD_PROJECT).toBe('demo-hammer');
    expect(process.env.GCLOUD_PROJECT).not.toBe('thehammer');
  });
});

// ── Capture ──────────────────────────────────────────────────────────

describe('SEC-01 — POST /upload-url refuses a Project in another Workspace', () => {
  test('403, and no signed URL is handed back', async () => {
    const res = await request(app).post('/upload-url').set(USER)
      .send({ project: BETA_PROJECT, tool: 'Softomedia' });

    expect(res.status).toBe(403);
    expect(res.body.uploadUrl).toBeUndefined();
    expect(res.body.url).toBeUndefined();
  });
});

describe('SEC-02 — POST /capture refuses a Project in another Workspace', () => {
  test('403, and no Capture is filed under the foreign Project', async () => {
    const before = await db.collection(collections.UPLOADS)
      .where('projectId', '==', BETA_PROJECT).get();

    const res = await request(app).post('/capture').set(USER)
      .field('projectId', BETA_PROJECT)
      .field('tool', 'Softomedia')
      .attach('file', PNG, { filename: 'shot.png', contentType: 'image/png' });

    expect(res.status).toBe(403);

    const after = await db.collection(collections.UPLOADS)
      .where('projectId', '==', BETA_PROJECT).get();
    expect(after.size).toBe(before.size);
  });
});

describe("SEC-03 — GET /admin/projects/:id/activity refuses another Workspace's Captures", () => {
  test('403, and Beta\'s Capture rows are not returned', async () => {
    const res = await request(app)
      .get(`/admin/projects/${BETA_PROJECT}/activity`)
      .set(ADMIN);

    expect(res.status).toBe(403);
    expect(res.body.uploads).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('beta-capture-1');
  });
});

describe("SEC-04 — GET /admin/projects/:id/export refuses another Workspace's Captures", () => {
  test('403, and no archive is produced', async () => {
    const res = await request(app)
      .get(`/admin/projects/${BETA_PROJECT}/export`)
      .set(ADMIN);

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).not.toMatch(/zip/);
  });
});

// ── Session ──────────────────────────────────────────────────────────

describe('SEC-05 — POST /session-events refuses a Project in another Workspace', () => {
  test('403, and no Session is recorded against Beta', async () => {
    const res = await request(app).post('/session-events').set(USER)
      .send({
        sessionId: 'cross-workspace-session',
        projectId: BETA_PROJECT,
        sessionStart: '2026-09-02T09:00:00.000Z',
        sessionEnd:   '2026-09-02T10:00:00.000Z',
      });

    expect(res.status).toBe(403);

    const written = await db.collection(collections.SESSION_EVENTS)
      .doc('cross-workspace-session').get();
    expect(written.exists).toBe(false);
  });
});

describe('SEC-06 — POST /inactivity-events refuses a Project in another Workspace', () => {
  test('403, and no inactivity row is recorded against Beta', async () => {
    const res = await request(app).post('/inactivity-events').set(USER)
      .send({
        eventId: 'cross-workspace-inactivity',
        sessionId: 'cross-workspace-session',
        projectId: BETA_PROJECT,
        inactiveStart: '2026-09-02T09:10:00.000Z',
        inactiveEnd:   '2026-09-02T09:20:00.000Z',
      });

    expect(res.status).toBe(403);

    const written = await db.collection(collections.INACTIVITY_EVENTS)
      .doc('cross-workspace-inactivity').get();
    expect(written.exists).toBe(false);
  });
});

// ── Monitored User ───────────────────────────────────────────────────

describe('SEC-07 — /admin/users does not disclose a Monitored User in another Workspace', () => {
  test("GET /admin/users/:id is refused, and Beta's Monitored User is not disclosed", async () => {
    const res = await request(app).get(`/admin/users/${BETA_USER}`).set(ADMIN);

    expectRefused(res);
    expect(JSON.stringify(res.body)).not.toContain('beta-monitored@test.com');
  });

  // The roster is a list, so there is no request here to refuse. Asserting only
  // that Beta is absent would pass against a broken query that returned
  // nothing at all, so this asserts Alpha's own users are present in the same
  // response — the filter is doing work, and the work is a Workspace boundary.
  test('GET /admin/users lists the caller\'s own Workspace and no other', async () => {
    const res = await request(app).get('/admin/users').set(ADMIN);

    expect(res.status).toBe(200);
    const emails = res.body.users.map((u) => u.email);
    expect(emails).toContain('iso-admin@test.com');
    expect(emails).toContain('iso-user@test.com');
    expect(emails).not.toContain('beta-monitored@test.com');
  });

  test('POST /admin/users does not hand back a Monitored User held by another Workspace', async () => {
    const res = await request(app).post('/admin/users').set(ADMIN)
      .send({ email: 'beta-monitored@test.com', displayName: 'Mine now', role: 'admin' });

    expectRefused(res);
    expect(JSON.stringify(res.body)).not.toContain('Beta Monitored User');

    const after = await db.collection(collections.USERS).doc(BETA_USER).get();
    expect(after.data().workspaceId).toBe(BETA);
    expect(after.data().role).toBe('user');
  });

  // The records that made the fallback necessary: POST /admin/users wrote
  // users with no workspaceId until this ticket, and "no Workspace" must read
  // as foreign to everyone rather than as "belongs to whoever asked" — the
  // second reading would leave the hole SEC-07 and SEC-08 close.
  test('a record carrying no Workspace at all is foreign, not everyone\'s', async () => {
    const stray = db.collection(collections.USERS).doc('legacy-unstamped-user');
    await stray.set({
      email: 'legacy-unstamped@test.com',
      displayName: 'Provisioned before workspaceId existed',
      role: 'user',
      createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      schemaVersion: 1,
    });

    const read = await request(app).get('/admin/users/legacy-unstamped-user').set(ADMIN);
    expectRefused(read);

    const write = await request(app).patch('/admin/users/legacy-unstamped-user').set(ADMIN)
      .send({ role: 'admin' });
    expectRefused(write);
    expect((await stray.get()).data().role).toBe('user');

    await stray.delete();
  });

  test('a user provisioned by an Admin is placed in that Admin\'s Workspace', async () => {
    const res = await request(app).post('/admin/users').set(ADMIN)
      .send({ email: 'freshly-provisioned@test.com', role: 'user' });

    expect(res.status).toBe(201);
    const created = await db.collection(collections.USERS).doc(res.body.id).get();
    expect(created.data().workspaceId).toBe(ALPHA);
  });
});

describe('SEC-08 — PATCH /admin/users/:id refuses a Monitored User in another Workspace', () => {
  test("refused, and Beta's record is unchanged", async () => {
    const res = await request(app).patch(`/admin/users/${BETA_USER}`).set(ADMIN)
      .send({ role: 'admin' });

    expectRefused(res);

    const after = await db.collection(collections.USERS).doc(BETA_USER).get();
    expect(after.data().role).toBe('user');
    expect(after.data().workspaceId).toBe(BETA);
  });
});

describe("SEC-09 — POST /admin/projects/:id/members refuses another Workspace's Monitored User", () => {
  test('refused when the Monitored User is foreign, and no membership is written', async () => {
    const res = await request(app)
      .post(`/admin/projects/${ALPHA_PROJECT}/members`)
      .set(ADMIN)
      .send({ userId: BETA_USER, role: 'user' });

    expectRefused(res);

    const membership = await db.collection(collections.MEMBERSHIPS)
      .doc(`${ALPHA_PROJECT}_${BETA_USER}`).get();
    expect(membership.exists).toBe(false);
  });

  test('refused when the Project is foreign, and no membership is written', async () => {
    const res = await request(app)
      .post(`/admin/projects/${BETA_PROJECT}/members`)
      .set(ADMIN)
      .send({ userId: 'iso-user-id', role: 'user' });

    expectRefused(res);

    const membership = await db.collection(collections.MEMBERSHIPS)
      .doc(`${BETA_PROJECT}_iso-user-id`).get();
    expect(membership.exists).toBe(false);
  });
});

describe("SEC-10 — the roster routes refuse another Workspace's Project", () => {
  test("GET /admin/projects/:id/members is refused and lists no Beta member", async () => {
    const res = await request(app)
      .get(`/admin/projects/${BETA_PROJECT}/members`)
      .set(ADMIN);

    expectRefused(res);
    expect(res.body.members).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('beta-monitored@test.com');
  });

  test("GET /admin/users?projectId= is refused for another Workspace's Project", async () => {
    const res = await request(app)
      .get(`/admin/users?projectId=${BETA_PROJECT}`)
      .set(ADMIN);

    expectRefused(res);
    expect(res.body.users).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('beta-monitored@test.com');
  });

  test('DELETE /admin/projects/:id/members/:userId is refused, and the membership survives', async () => {
    const res = await request(app)
      .delete(`/admin/projects/${BETA_PROJECT}/members/${BETA_USER}`)
      .set(ADMIN);

    expectRefused(res);

    const membership = await db.collection(collections.MEMBERSHIPS).doc(BETA_MEMBERSHIP).get();
    expect(membership.exists).toBe(true);
  });
});

// ── Admin and Analyst routes over the Project record itself ──────────

describe("SEC-11 — the Project routes refuse another Workspace's Project", () => {
  test('GET /admin/projects/:id is refused and discloses no Beta Project', async () => {
    const res = await request(app).get(`/admin/projects/${BETA_PROJECT}`).set(ADMIN);

    expectRefused(res);
    expect(JSON.stringify(res.body)).not.toContain('Beta work');
  });

  test('PATCH /admin/projects/:id is refused, and the Beta Project is unchanged', async () => {
    const res = await request(app).patch(`/admin/projects/${BETA_PROJECT}`).set(ADMIN)
      .send({ name: 'Renamed by Alpha' });

    expectRefused(res);

    const after = await db.collection(collections.PROJECTS).doc(BETA_PROJECT).get();
    expect(after.data().name).toBe('Beta work');
  });

  test('DELETE /admin/projects/:id is refused, and the Beta Project survives', async () => {
    const res = await request(app).delete(`/admin/projects/${BETA_PROJECT}`).set(ADMIN);

    expectRefused(res);

    const after = await db.collection(collections.PROJECTS).doc(BETA_PROJECT).get();
    expect(after.exists).toBe(true);
  });
});

describe("SEC-12 — the report routes refuse another Workspace's reports", () => {
  test('GET /admin/reports/:id/status is refused and discloses no path', async () => {
    const res = await request(app)
      .get(`/admin/reports/${BETA_REPORT}/status`)
      .set(ANALYST);

    expectRefused(res);
    expect(res.body.gcsPath).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(`reports/${BETA_REPORT}.pdf`);
  });

  test('GET /admin/reports?projectId= is refused and lists no Beta report', async () => {
    const res = await request(app)
      .get(`/admin/reports?projectId=${BETA_PROJECT}`)
      .set(ANALYST);

    expectRefused(res);
    expect(res.body.reports).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(BETA_REPORT);
  });
});

// #99 — SEC-13: a foreign Project id and a nonexistent one are one answer.
//
// The twelve cases above prove Alpha cannot *reach* Beta. This one proves Alpha
// cannot *distinguish*: before #99 the Admin routes answered 404 for a Project
// that does not exist and 403 for one belonging to another Customer, so an
// outsider could sort real Project ids from imaginary ones by reading the
// status code — a smaller disclosure than the rows themselves, and the last one
// the split answer made possible.
//
// Asserting the two responses are identical, rather than that each is 403,
// is what makes this fail if either side drifts.
describe('SEC-13 — an unreachable Project does not say why it is unreachable', () => {
  const NONEXISTENT = 'no-such-project-at-all';

  test('GET /admin/projects/:id answers a foreign id and an unknown id alike', async () => {
    const foreign = await request(app).get(`/admin/projects/${BETA_PROJECT}`).set(ADMIN);
    const unknown = await request(app).get(`/admin/projects/${NONEXISTENT}`).set(ADMIN);

    expect(foreign.status).toBe(403);
    expect(unknown.status).toBe(foreign.status);
    expect(unknown.body).toEqual(foreign.body);
  });

  test('GET /admin/projects/:id/activity answers a foreign id and an unknown id alike', async () => {
    const foreign = await request(app).get(`/admin/projects/${BETA_PROJECT}/activity`).set(ADMIN);
    const unknown = await request(app).get(`/admin/projects/${NONEXISTENT}/activity`).set(ADMIN);

    expect(foreign.status).toBe(403);
    expect(unknown.status).toBe(foreign.status);
    expect(unknown.body).toEqual(foreign.body);
  });

  // The two membership routes check ownership inside a transaction, where they
  // cannot write a response and throw instead. That is a second code path to
  // the same rule, and it was the one the first pass of #99 missed: the
  // workspace comparison moved to the helper while the 404-for-missing above it
  // stayed, so these two kept the split answer. Nothing failed, because no case
  // had ever named a Project that does not exist here.
  test('POST /admin/projects/:id/members answers a foreign id and an unknown id alike', async () => {
    const body = { userId: 'iso-user-id', role: 'user' };
    const foreign = await request(app)
      .post(`/admin/projects/${BETA_PROJECT}/members`).set(ADMIN).send(body);
    const unknown = await request(app)
      .post(`/admin/projects/${NONEXISTENT}/members`).set(ADMIN).send(body);

    expect(foreign.status).toBe(403);
    expect(unknown.status).toBe(foreign.status);
    expect(unknown.body).toEqual(foreign.body);
  });

  test('DELETE /admin/projects/:id/members/:userId answers a foreign id and an unknown id alike', async () => {
    const foreign = await request(app)
      .delete(`/admin/projects/${BETA_PROJECT}/members/${BETA_USER}`).set(ADMIN);
    const unknown = await request(app)
      .delete(`/admin/projects/${NONEXISTENT}/members/${BETA_USER}`).set(ADMIN);

    expect(foreign.status).toBe(403);
    expect(unknown.status).toBe(foreign.status);
    expect(unknown.body).toEqual(foreign.body);

    // Beta's membership survives both attempts.
    const membership = await db.collection(collections.MEMBERSHIPS).doc(BETA_MEMBERSHIP).get();
    expect(membership.exists).toBe(true);
  });

  test('a Project the caller does own still answers normally', async () => {
    const res = await request(app).get(`/admin/projects/${ALPHA_PROJECT}`).set(ADMIN);
    expect(res.status).toBe(200);
  });
});
