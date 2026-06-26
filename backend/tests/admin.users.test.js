/**
 * Sprint 5.6–5.7  —  Unit test skeleton for /admin/users and /admin/projects/:id/members
 *
 * Same setup as admin.projects.test.js — uses Firestore Emulator + supertest.
 */

'use strict';

process.env.NODE_ENV                = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';

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
