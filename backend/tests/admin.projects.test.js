/**
 * Sprint 5.2–5.5  —  /admin/projects routes
 *
 * Test runner: Jest
 * Firestore:   Firestore Emulator  (FIRESTORE_EMULATOR_HOST=127.0.0.1:8085)
 * Auth shim:   X-Dev-User-Email (requireRole dev fallback, NODE_ENV=test)
 */

'use strict';

// #114: the Purge's storage half needs a bucket with objects in it, so this
// suite now runs against the shared Cloud Storage double.
jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock());

const request = require('supertest');
const {
  clearDatabase, seedUser, seedProject, seedMembership, seedCapture, seedReport,
} = require('./helpers/fixtures');
const {
  seedObject, listObjects, resetObjects, failNextPrefixDelete,
} = require('./helpers/gcsMock');
const collections = require('../src/lib/collections');
const { PURGED_COLLECTIONS } = require('../src/lib/purge');

let app, db;

beforeAll(async () => {
  app = require('../src/index').app;
  db  = require('../src/lib/firestore').db;

  await clearDatabase();
  await seedUser('test-admin-id-projects', {
    email: 'admin-projects@test.com',
    role: 'admin'
  });
});

afterAll(async () => {
  await clearDatabase();
});

const H = {
  'x-dev-user-email': 'admin-projects@test.com',
  'content-type':     'application/json',
};

describe('POST /admin/projects', () => {
  let createdId;

  afterEach(async () => {
    if (createdId) {
      await db.collection('project_memberships')
        .doc(`${createdId}_test-admin-id-projects`).delete().catch(() => {});
      await db.collection('projects').doc(createdId).delete().catch(() => {});
      createdId = null;
    }
  });

  test('201 — creates project with valid name', async () => {
    const res = await request(app)
      .post('/admin/projects')
      .set(H)
      .send({ name: 'Test Project Alpha' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name:          'Test Project Alpha',
      adminId:       'test-admin-id-projects',
      // #47: the creator is admitted as a member by the same transaction.
      memberCount:   1,
      schemaVersion: 1,
    });
    expect(res.body.id).toBeTruthy();
    createdId = res.body.id;
  });

  test('400 — rejects empty name', async () => {
    const res = await request(app).post('/admin/projects').set(H).send({ name: '' });
    expect(res.status).toBe(400);
  });

  test('400 — rejects name > 128 chars', async () => {
    const res = await request(app).post('/admin/projects').set(H).send({ name: 'x'.repeat(129) });
    expect(res.status).toBe(400);
  });

  test('401 — rejects request without auth header', async () => {
    const res = await request(app)
      .post('/admin/projects')
      .set('content-type', 'application/json')
      .send({ name: 'No Auth Project' });
    expect(res.status).toBe(401);
  });
});

describe('GET /admin/projects', () => {
  let pid = 'get-test-project';

  beforeAll(async () => {
    await seedProject(pid, {
      name: 'GET Test Project',
      adminId: 'test-admin-id-projects'
    });
  });

  afterAll(async () => {
    await db.collection('projects').doc(pid).delete().catch(() => {});
  });

  test('200 — returns projects array', async () => {
    const res = await request(app).get('/admin/projects').set(H);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.projects)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });
});

describe('PATCH /admin/projects/:id', () => {
  let pid = 'patch-test-project';

  beforeEach(async () => {
    await seedProject(pid, {
      name: 'Original Name',
      adminId: 'test-admin-id-projects'
    });
  });

  afterEach(async () => {
    await db.collection('projects').doc(pid).delete().catch(() => {});
  });

  test('200 — renames project', async () => {
    const res = await request(app)
      .patch(`/admin/projects/${pid}`)
      .set(H)
      .send({ name: 'Renamed Project' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed Project');
  });

  // #99: 403, not 404. A Project the caller cannot have and a Project that
  // does not exist now answer identically — see tests/workspace-isolation.js
  // for why the split answer was a disclosure.
  test('403 — non-existent project', async () => {
    const res = await request(app)
      .patch('/admin/projects/does-not-exist-xyz')
      .set(H)
      .send({ name: 'Ghost' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /admin/projects/:id', () => {
  test('204 — deletes project and memberships', async () => {
    const pid = 'delete-test-project';
    await seedProject(pid, {
      name: 'To Delete',
      adminId: 'test-admin-id-projects'
    });
    const res = await request(app).delete(`/admin/projects/${pid}`).set(H);
    expect(res.status).toBe(204);
    const check = await db.collection('projects').doc(pid).get();
    expect(check.exists).toBe(false);
  });

  test('403 — non-existent project', async () => {
    const res = await request(app).delete('/admin/projects/ghost-project-xyz').set(H);
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────
// #114 — Deleting a Project is a Purge
//
// The route removed the Project document and its memberships and nothing else,
// which left 17 unreachable records and 26 objects in production (#109). Every
// read path resolves a Capture through its Project, so what stayed behind could
// not be listed, exported or reported on by anyone.
//
// These assert what an Admin can observe after a Purge — what is left in each
// collection and in the bucket — rather than batch sizes or call ordering. The
// one exception is the ordering rule, which is external behaviour precisely
// because a retry depends on it (ADR 0015).
// ─────────────────────────────────────────────────────────────────
describe('DELETE /admin/projects/:id — the Purge (#114)', () => {
  const PID = 'purge-project';
  const OTHER = 'purge-bystander';

  /**
   * The six collections that carry a `projectId`, stated here independently of
   * the list the code purges from. Deriving this from `PURGED_COLLECTIONS`
   * would make every case below agree with the cascade by construction — a
   * collection missing from that list would also be missing from the
   * expectations, and the suite would pass over the gap (lesson 75).
   *
   * The next test pins the two lists together, so a seventh collection has to
   * be added in both places or the suite fails.
   */
  const CARRIES_PROJECT_ID = [
    collections.UPLOADS, collections.REPORTS, collections.SESSION_EVENTS,
    collections.INACTIVITY_EVENTS, collections.STORYBOARD_DRAFTS, collections.MEMBERSHIPS,
  ];

  test('the cascade purges exactly the collections these tests know about', () => {
    expect([...PURGED_COLLECTIONS].sort()).toEqual([...CARRIES_PROJECT_ID].sort());
  });

  /** Every collection that carries a `projectId`, and a row of each for `id`. */
  async function seedChildren(id) {
    await seedCapture(`${id}-cap`, { projectId: id });
    await seedReport(`${id}-rep`, { projectId: id });
    await seedMembership(id, 'test-admin-id-projects');
    await db.collection(collections.SESSION_EVENTS).doc(`${id}-sess`).set({
      sessionId: `${id}-sess`, projectId: id, userId: 'test-user', schemaVersion: 1,
    });
    // The trap: `inactivity_events` carries a projectId but is only ever
    // queried by sessionId, so a cascade written from the read paths misses it.
    await db.collection(collections.INACTIVITY_EVENTS).doc(`${id}-inact`).set({
      eventId: `${id}-inact`, sessionId: `${id}-sess`, projectId: id, schemaVersion: 1,
    });
    await db.collection(collections.STORYBOARD_DRAFTS).doc(`${id}-draft`).set({
      projectId: id, status: 'draft', captures: [], schemaVersion: 1,
    });
  }

  /** How many rows in each collection still name `id`. */
  async function survivorsOf(id) {
    const out = {};
    for (const name of CARRIES_PROJECT_ID) {
      const snap = await db.collection(name).where('projectId', '==', id).get();
      out[name] = snap.size;
    }
    return out;
  }

  const NOTHING_LEFT = {
    [collections.UPLOADS]: 0, [collections.REPORTS]: 0,
    [collections.SESSION_EVENTS]: 0, [collections.INACTIVITY_EVENTS]: 0,
    [collections.STORYBOARD_DRAFTS]: 0, [collections.MEMBERSHIPS]: 0,
  };

  /** Leftovers from a case whose Purge was meant to fail or be refused. */
  async function clearChildrenOf(id) {
    for (const name of CARRIES_PROJECT_ID) {
      const snap = await db.collection(name).where('projectId', '==', id).get();
      await Promise.all(snap.docs.map((d) => d.ref.delete()));
    }
    await db.collection(collections.PROJECTS).doc(id).delete().catch(() => {});
  }

  beforeEach(async () => {
    resetObjects();
    for (const id of [PID, OTHER, 'purge-foreign']) await clearChildrenOf(id);
    const purges = await db.collection(collections.PURGES).get();
    await Promise.all(purges.docs.map((d) => d.ref.delete()));
    await seedProject(PID, { name: 'Purge Me', adminId: 'test-admin-id-projects' });
  });

  test('every record in all six collections goes, inactivity_events included', async () => {
    await seedChildren(PID);

    const res = await request(app).delete(`/admin/projects/${PID}`).set(H);

    expect(res.status).toBe(204);
    expect(await survivorsOf(PID)).toEqual(NOTHING_LEFT);
  });

  test('every object under the Project prefix goes — images, sidecars and videos alike', async () => {
    seedObject(`${PID}/test-user/shot.png`);
    seedObject(`${PID}/test-user/shot.json`);
    seedObject(`${PID}/reports/walkthrough.mp4`);
    await seedChildren(PID);

    await request(app).delete(`/admin/projects/${PID}`).set(H);

    expect(listObjects(`${PID}/`)).toEqual([]);
  });

  test('another Project\'s objects are untouched', async () => {
    seedObject(`${PID}/test-user/mine.png`);
    seedObject(`${OTHER}/test-user/theirs.png`);

    await request(app).delete(`/admin/projects/${PID}`).set(H);

    expect(listObjects()).toEqual([`${OTHER}/test-user/theirs.png`]);
  });

  test('another Project\'s records are untouched', async () => {
    await seedProject(OTHER, { name: 'Bystander', adminId: 'test-admin-id-projects' });
    await seedChildren(PID);
    await seedChildren(OTHER);

    await request(app).delete(`/admin/projects/${PID}`).set(H);

    expect(await survivorsOf(OTHER)).toEqual({
      [collections.UPLOADS]: 1, [collections.REPORTS]: 1,
      [collections.SESSION_EVENTS]: 1, [collections.INACTIVITY_EVENTS]: 1,
      [collections.STORYBOARD_DRAFTS]: 1, [collections.MEMBERSHIPS]: 1,
    });
    expect((await db.collection(collections.PROJECTS).doc(OTHER).get()).exists).toBe(true);
  });

  test('a Project holding nothing Purges successfully', async () => {
    const res = await request(app).delete(`/admin/projects/${PID}`).set(H);

    expect(res.status).toBe(204);
    expect((await db.collection(collections.PROJECTS).doc(PID).get()).exists).toBe(false);
  });

  // An Abandoned Upload is a record whose image never arrived — the upload route
  // writes the row before the extension sends the bytes, deliberately. Six of
  // the seventeen unreachable records in #109 are these.
  test('an Abandoned Upload — a record whose object never existed — does not fail the Purge', async () => {
    await seedCapture(`${PID}-abandoned`, { projectId: PID });
    expect(listObjects(`${PID}/`)).toEqual([]);

    const res = await request(app).delete(`/admin/projects/${PID}`).set(H);

    expect(res.status).toBe(204);
    expect(await survivorsOf(PID)).toEqual(NOTHING_LEFT);
  });

  // The ordering rule. While the Project document survives its children are
  // still addressable, so a Purge that dies halfway is a Purge you run again —
  // which is the opposite of what the route did, and exactly how #109 happened.
  test('a Purge interrupted mid-cascade leaves the Project, and a re-run completes it', async () => {
    seedObject(`${PID}/test-user/shot.png`);
    await seedChildren(PID);
    failNextPrefixDelete();

    const failed = await request(app).delete(`/admin/projects/${PID}`).set(H);

    expect(failed.status).toBe(500);
    expect((await db.collection(collections.PROJECTS).doc(PID).get()).exists).toBe(true);

    const retry = await request(app).delete(`/admin/projects/${PID}`).set(H);

    expect(retry.status).toBe(204);
    expect((await db.collection(collections.PROJECTS).doc(PID).get()).exists).toBe(false);
    expect(await survivorsOf(PID)).toEqual(NOTHING_LEFT);
    expect(listObjects(`${PID}/`)).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────
  // #115 — Every Purge leaves a record
  //
  // After a Purge there is nothing left to inspect; that is the point of it. So
  // the record is the only trace, and it is written while the facts are still
  // available. The five Projects that produced #109 were identified only by
  // their absence, noticed three weeks later during unrelated work.
  // ───────────────────────────────────────────────────────────────
  async function purgeRecordsFor(id) {
    const snap = await db.collection(collections.PURGES).where('projectId', '==', id).get();
    return snap.docs.map((d) => d.data());
  }

  test('a Purge writes exactly one record, naming the Project, the Workspace and who did it', async () => {
    await seedChildren(PID);

    await request(app).delete(`/admin/projects/${PID}`).set(H);

    const records = await purgeRecordsFor(PID);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      projectId:   PID,
      projectName: 'Purge Me',
      workspaceId: 'test-workspace',
      purgedBy:    'test-admin-id-projects',
    });
    expect(Date.parse(records[0].purgedAt)).not.toBeNaN();
  });

  test('the record carries the counts removed, per collection and for storage', async () => {
    await seedChildren(PID);
    await seedCapture(`${PID}-cap2`, { projectId: PID });
    seedObject(`${PID}/test-user/one.png`);
    seedObject(`${PID}/test-user/one.json`);

    await request(app).delete(`/admin/projects/${PID}`).set(H);

    const [record] = await purgeRecordsFor(PID);
    expect(record.counts).toEqual({
      [collections.UPLOADS]: 2,
      [collections.REPORTS]: 1,
      [collections.SESSION_EVENTS]: 1,
      [collections.INACTIVITY_EVENTS]: 1,
      [collections.STORYBOARD_DRAFTS]: 1,
      [collections.MEMBERSHIPS]: 1,
    });
    expect(record.objectsRemoved).toBe(2);
  });

  test('a Project holding nothing still leaves a record, with zero counts', async () => {
    await request(app).delete(`/admin/projects/${PID}`).set(H);

    const [record] = await purgeRecordsFor(PID);
    expect(record).toBeDefined();
    expect(record.objectsRemoved).toBe(0);
    expect(Object.values(record.counts)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  // Lesson 67, ADR 0014, and the rule #111 breaks: an absent value means the
  // record belongs to nobody, never to whoever asked. The Project is already
  // loaded for the ownership check, so taking it from there costs no read.
  test('the record\'s Workspace comes from the Project, not from the caller', async () => {
    await seedProject(PID, {
      name: 'Purge Me', adminId: 'test-admin-id-projects', workspaceId: 'test-workspace',
    });
    // The caller's own Workspace and the Project's agree here, as they must for
    // the Purge to be permitted at all — so the value is pinned to the Project
    // by reading it back off the Project before it goes.
    const before = (await db.collection(collections.PROJECTS).doc(PID).get()).data();

    await request(app).delete(`/admin/projects/${PID}`).set(H);

    const [record] = await purgeRecordsFor(PID);
    expect(record.workspaceId).toBe(before.workspaceId);
  });

  test('a Purge that fails partway writes no record, and the retry writes one', async () => {
    seedObject(`${PID}/test-user/shot.png`);
    failNextPrefixDelete();

    await request(app).delete(`/admin/projects/${PID}`).set(H);
    expect(await purgeRecordsFor(PID)).toHaveLength(0);

    await request(app).delete(`/admin/projects/${PID}`).set(H);
    expect(await purgeRecordsFor(PID)).toHaveLength(1);
  });

  // #99: one answer for unreachable. A Project in another Workspace and a
  // Project that was never real must be refused identically, or the status code
  // sorts real ids from imaginary ones.
  test('a foreign Project refuses exactly as a non-existent one does', async () => {
    await seedProject('purge-foreign', {
      name: 'Theirs', adminId: 'other-admin', workspaceId: 'some-other-workspace',
    });
    await seedCapture('purge-foreign-cap', { projectId: 'purge-foreign' });
    seedObject('purge-foreign/test-user/theirs.png');

    const foreign = await request(app).delete('/admin/projects/purge-foreign').set(H);
    const ghost   = await request(app).delete('/admin/projects/never-existed').set(H);

    expect(foreign.status).toBe(ghost.status);
    expect(foreign.body).toEqual(ghost.body);
    expect(foreign.status).toBe(403);
    // The refusal is not a no-op that happened to answer 403.
    expect((await db.collection(collections.PROJECTS).doc('purge-foreign').get()).exists).toBe(true);
    expect(listObjects('purge-foreign/')).toEqual(['purge-foreign/test-user/theirs.png']);
  });
});

// ─────────────────────────────────────────────────────────────────
// #116 — the route serving a Project supplies its Capture count
//
// The confirmation modal has to state how much is about to be destroyed, and it
// can only state a number the route sends. Of five Projects in production three
// hold no Captures at all and two hold 100 and 17 objects — the number is the
// whole difference between a harmless click and a destructive one.
//
// The count is of Captures, the number an Admin recognises. An Abandoned Upload
// is a Capture row whose image never arrived, so the object count may differ,
// and it is not shown.
// ─────────────────────────────────────────────────────────────────
describe('GET /admin/projects/:id — the Capture count (#116)', () => {
  const PID = 'count-project';

  beforeEach(async () => {
    const rows = await db.collection(collections.UPLOADS).where('projectId', '==', PID).get();
    await Promise.all(rows.docs.map((d) => d.ref.delete()));
    await seedProject(PID, { name: 'Counted', adminId: 'test-admin-id-projects' });
  });

  test('a Project with Captures reports how many', async () => {
    await seedCapture(`${PID}-a`, { projectId: PID });
    await seedCapture(`${PID}-b`, { projectId: PID });

    const res = await request(app).get(`/admin/projects/${PID}`).set(H);

    expect(res.status).toBe(200);
    expect(res.body.captureCount).toBe(2);
  });

  test('a Project with none reports zero rather than omitting the field', async () => {
    const res = await request(app).get(`/admin/projects/${PID}`).set(H);

    expect(res.body.captureCount).toBe(0);
  });

  test('the count is of this Project only', async () => {
    await seedProject('count-other', { name: 'Other', adminId: 'test-admin-id-projects' });
    await seedCapture(`${PID}-a`, { projectId: PID });
    await seedCapture('count-other-a', { projectId: 'count-other' });

    const res = await request(app).get(`/admin/projects/${PID}`).set(H);

    expect(res.body.captureCount).toBe(1);
  });
});

// #47 — creating a Project wrote no membership row for its creator, so the
// Admin who had just created it saw "— no projects assigned —" in the
// extension. adminId records who created the Project and confers no access;
// every read path resolves access through project_memberships.
describe('POST /admin/projects — the creator becomes a member (#47)', () => {
  let createdId;

  afterEach(async () => {
    if (createdId) {
      await db.collection('project_memberships')
        .doc(`${createdId}_test-admin-id-projects`).delete().catch(() => {});
      await db.collection('projects').doc(createdId).delete().catch(() => {});
      createdId = null;
    }
  });

  test('the creator can select the new Project immediately', async () => {
    const created = await request(app)
      .post('/admin/projects')
      .set(H)
      .send({ name: 'Creator Visible Project' });
    expect(created.status).toBe(201);
    createdId = created.body.id;

    const mine = await request(app).get('/me/projects').set(H);
    expect(mine.status).toBe(200);
    expect(mine.body.projects.map(p => p.id)).toContain(createdId);
  });

  test('writes exactly one membership row, and memberCount agrees with it', async () => {
    const created = await request(app)
      .post('/admin/projects')
      .set(H)
      .send({ name: 'Membership Count Project' });
    expect(created.status).toBe(201);
    createdId = created.body.id;

    const rows = await db.collection('project_memberships')
      .where('projectId', '==', createdId).get();
    expect(rows.docs.map(d => d.data().userId)).toEqual(['test-admin-id-projects']);
    expect(rows.docs[0].data().admittedBy).toBe('test-admin-id-projects');

    const project = await db.collection('projects').doc(createdId).get();
    expect(project.data().memberCount).toBe(rows.size);
  });
});
