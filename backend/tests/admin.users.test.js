/**
 * Sprint 5.6–5.7  —  Unit test skeleton for /admin/users and /admin/projects/:id/members
 *
 * Same setup as admin.projects.test.js — uses Firestore Emulator + supertest.
 */

'use strict';


const request = require('supertest');
const { clearDatabase, seedUser, seedProject, seedMembership } = require('./helpers/fixtures');

let app, db;

beforeAll(async () => {
  app = require('../src/index').app;
  db  = require('../src/lib/firestore').db;

  await clearDatabase();
  await seedUser('test-admin-id-users', {
    email: 'admin-users@test.com',
    role: 'admin'
  });
});

afterAll(async () => {
  await clearDatabase();
});

const H = { 'x-dev-user-email': 'admin-users@test.com', 'content-type': 'application/json' };

describe('POST /admin/users', () => {
  afterEach(async () => {
    const snap = await db.collection('users').where('email', '==', 'new@test.com').get();
    for (const d of snap.docs) await d.ref.delete();
  });

  test('201 — provisions new user', async () => {
    const res = await request(app).post('/admin/users').set(H)
      .send({ email: 'new@test.com', displayName: 'New User', role: 'analyst' });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe('new@test.com');
    expect(res.body.role).toBe('analyst');
    expect(res.body.schemaVersion).toBe(1);
  });

  test('200 — idempotent on duplicate email', async () => {
    await request(app).post('/admin/users').set(H)
      .send({ email: 'new@test.com', role: 'user' });
    const res = await request(app).post('/admin/users').set(H)
      .send({ email: 'new@test.com', role: 'admin' });
    expect(res.status).toBe(200);   // returns existing, does not upgrade role
  });

  test('400 — invalid email', async () => {
    const res = await request(app).post('/admin/users').set(H)
      .send({ email: 'not-an-email', role: 'user' });
    expect(res.status).toBe(400);
  });

  test('400 — invalid role', async () => {
    const res = await request(app).post('/admin/users').set(H)
      .send({ email: 'x@test.com', role: 'superuser' });
    expect(res.status).toBe(400);
  });
});

describe('POST + DELETE /admin/projects/:id/members', () => {
  let projectId = 'member-test-project';
  let memberId = 'member-user-id';

  beforeAll(async () => {
    await seedProject(projectId, {
      name: 'Member Test Project',
      adminId: 'test-admin-id-users'
    });

    await seedUser(memberId, {
      email: 'member@test.com',
      displayName: 'Test Member',
      role: 'user'
    });
  });

  afterAll(async () => {
    await db.collection('projects').doc(projectId).delete().catch(() => {});
    await db.collection('users').doc(memberId).delete().catch(() => {});
    await db.collection('project_memberships').doc(`${projectId}_${memberId}`).delete().catch(() => {});
  });

  test('201 — admits user and increments memberCount', async () => {
    const res = await request(app)
      .post(`/admin/projects/${projectId}/members`)
      .set(H).send({ userId: memberId, role: 'user' });
    expect(res.status).toBe(201);

    const proj = await db.collection('projects').doc(projectId).get();
    expect(proj.data().memberCount).toBe(1);
  });

  test('409 — duplicate membership', async () => {
    const res = await request(app)
      .post(`/admin/projects/${projectId}/members`)
      .set(H).send({ userId: memberId, role: 'user' });
    expect(res.status).toBe(409);
  });

  test('204 — removes member and decrements memberCount', async () => {
    const res = await request(app)
      .delete(`/admin/projects/${projectId}/members/${memberId}`)
      .set(H);
    expect(res.status).toBe(204);

    const proj = await db.collection('projects').doc(projectId).get();
    expect(proj.data().memberCount).toBe(0);
  });
});

// ── Issue #4 — role updates after the api_keys sync was removed ───
// PATCH used to gather api_keys refs inside its transaction and rewrite the
// role onto each one. Removing that read changes the shape of the transaction,
// so the role update itself needs a guard of its own; the second assertion
// stops the retired collection from being written again.
describe('PATCH /admin/users/:id — role updates', () => {
  const targetId = 'test-patch-role-user';

  beforeAll(async () => {
    await seedUser(targetId, { email: 'patch-role@test.com', role: 'user' });
  });

  afterAll(async () => {
    await db.collection('users').doc(targetId).delete().catch(() => {});
  });

  test('200 — persists the new role', async () => {
    const res = await request(app).patch(`/admin/users/${targetId}`)
      .set(H).send({ role: 'analyst' });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('analyst');

    const snap = await db.collection('users').doc(targetId).get();
    expect(snap.data().role).toBe('analyst');
  });

  // Seeded raw rather than through a fixture helper: this document stands in
  // for a key left behind in a real database after the code was removed. An
  // empty-collection assertion would pass vacuously, since nothing in this
  // suite writes keys either way.
  test('leaves a leftover api_keys document untouched', async () => {
    const keyRef = db.collection('api_keys').doc('leftover-key');
    await keyRef.set({ userId: targetId, role: 'user', isActive: true });

    const res = await request(app).patch(`/admin/users/${targetId}`)
      .set(H).send({ role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');

    const after = await keyRef.get();
    expect(after.data().role).toBe('user');
    expect(after.data()).not.toHaveProperty('updatedAt');

    await keyRef.delete();
  });
});

describe('GET /admin/users — ?projectId= filter', () => {
  const projA = 'filter-project-a';
  const projB = 'filter-project-b';
  // Emails are chosen so the expected email-asc order is unambiguous.
  const alice = 'filter-user-alice';   // member of A, role user
  const bob   = 'filter-user-bob';     // member of A, role analyst
  const carol = 'filter-user-carol';   // member of B only

  beforeAll(async () => {
    await seedProject(projA, { name: 'Filter Project A' });
    await seedProject(projB, { name: 'Filter Project B' });

    await seedUser(alice, { email: 'a-alice@filter.test', role: 'user' });
    await seedUser(bob,   { email: 'b-bob@filter.test',   role: 'analyst' });
    await seedUser(carol, { email: 'c-carol@filter.test', role: 'user' });

    await seedMembership(projA, alice, { admittedAt: '2026-01-01T00:00:00.000Z' });
    await seedMembership(projA, bob,   { admittedAt: '2026-01-02T00:00:00.000Z' });
    await seedMembership(projB, carol, { admittedAt: '2026-01-03T00:00:00.000Z' });
  });

  afterAll(async () => {
    for (const id of [alice, bob, carol]) {
      await db.collection('users').doc(id).delete().catch(() => {});
    }
    for (const [p, u] of [[projA, alice], [projA, bob], [projB, carol]]) {
      await db.collection('project_memberships').doc(`${p}_${u}`).delete().catch(() => {});
    }
    for (const p of [projA, projB]) {
      await db.collection('projects').doc(p).delete().catch(() => {});
    }
  });

  test('returns only the named project\'s members, with a second project seeded', async () => {
    const res = await request(app).get(`/admin/users?projectId=${projA}`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.users.map(u => u.id)).toEqual([alice, bob]);
  });

  test('total reflects the filtered count, not the workspace count', async () => {
    const all = await request(app).get('/admin/users').set(H);
    const res = await request(app).get(`/admin/users?projectId=${projA}`).set(H);
    expect(res.body.total).toBe(2);
    expect(all.body.total).toBeGreaterThan(res.body.total);
  });

  test('composes with ?role=', async () => {
    const res = await request(app).get(`/admin/users?projectId=${projA}&role=analyst`).set(H);
    expect(res.body.users.map(u => u.id)).toEqual([bob]);
    expect(res.body.total).toBe(1);
  });

  test('a cursor pages within the filtered set, never over the whole collection', async () => {
    const res = await request(app).get(`/admin/users?projectId=${projA}&cursor=${alice}`).set(H);
    expect(res.body.users.map(u => u.id)).toEqual([bob]);
    expect(res.body.nextCursor).toBeNull();
  });

  test('a project with no members returns an empty page and a null cursor', async () => {
    const res = await request(app).get('/admin/users?projectId=no-such-project').set(H);
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.nextCursor).toBeNull();
  });

  test('each filtered user carries the membership the portal renders as "Admitted"', async () => {
    const res = await request(app).get(`/admin/users?projectId=${projA}`).set(H);
    const [first] = res.body.users;
    expect(first.membership.projectId).toBe(projA);
    expect(first.membership.admittedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

// The second "Done when" bullet on #46 is about a page boundary, so verifying it
// needs a filtered set larger than one page. Seeded in one batch to stay quick.
describe('GET /admin/users — ?projectId= paging past the first page', () => {
  const projC = 'filter-project-big';
  const SIZE  = 101;   // PAGE_SIZE + 1, so page two holds exactly one User
  const idOf  = (i) => `big-user-${String(i).padStart(3, '0')}`;

  beforeAll(async () => {
    await seedProject(projC, { name: 'Filter Project Big' });
    const batch = db.batch();
    for (let i = 0; i < SIZE; i++) {
      batch.set(db.collection('users').doc(idOf(i)), {
        email: `${String(i).padStart(3, '0')}@big.test`,
        displayName: `Big ${i}`,
        role: 'user',
        workspaceId: 'test-workspace',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
        schemaVersion: 1
      });
      batch.set(db.collection('project_memberships').doc(`${projC}_${idOf(i)}`), {
        projectId: projC,
        userId: idOf(i),
        role: 'user',
        admittedAt: '2026-01-01T00:00:00.000Z',
        schemaVersion: 1
      });
    }
    await batch.commit();
  });

  afterAll(async () => {
    const batch = db.batch();
    for (let i = 0; i < SIZE; i++) {
      batch.delete(db.collection('users').doc(idOf(i)));
      batch.delete(db.collection('project_memberships').doc(`${projC}_${idOf(i)}`));
    }
    batch.delete(db.collection('projects').doc(projC));
    await batch.commit();
  });

  test('a non-null nextCursor always yields a non-empty next page', async () => {
    const first = await request(app).get(`/admin/users?projectId=${projC}`).set(H);
    expect(first.status).toBe(200);
    expect(first.body.users).toHaveLength(100);
    expect(first.body.nextCursor).toBe(idOf(99));

    const second = await request(app)
      .get(`/admin/users?projectId=${projC}&cursor=${first.body.nextCursor}`).set(H);
    expect(second.body.users.map(u => u.id)).toEqual([idOf(100)]);
    expect(second.body.nextCursor).toBeNull();
  });

  test('every page holds only members of the filtered project', async () => {
    const first = await request(app).get(`/admin/users?projectId=${projC}`).set(H);
    expect(first.body.users.every(u => u.membership.projectId === projC)).toBe(true);
  });

  test('total counts the rows in this page, as on the unfiltered branch', async () => {
    const res = await request(app).get(`/admin/users?projectId=${projC}`).set(H);
    // Deliberate: `total` means "rows in this page" on both branches. #46 asks for
    // "the filtered count"; making it the full filtered count here would leave the
    // two branches meaning different things by the same name.
    expect(res.body.total).toBe(100);
  });
});
