/**
 * Sprint 5.6–5.7  —  Unit test skeleton for /admin/users and /admin/projects/:id/members
 *
 * Same setup as admin.projects.test.js — uses Firestore Emulator + supertest.
 */

'use strict';

process.env.NODE_ENV                = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';

const request = require('supertest');

let app, db;

beforeAll(async () => {
  app = require('../src/index').app;
  db  = require('../src/lib/firestore').db;

  await db.collection('users').doc('test-admin-id').set({
    email: 'admin@test.com', displayName: 'Test Admin', role: 'admin',
    workspaceId: 'test-workspace',
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
    schemaVersion: 1,
  });
});

afterAll(async () => {
  await db.collection('users').doc('test-admin-id').delete();
});

const H = { 'x-dev-user-email': 'admin@test.com', 'content-type': 'application/json' };

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
  let projectId;
  let memberId = 'member-user-id';

  beforeAll(async () => {
    const ref = await db.collection('projects').add({
      name: 'Member Test Project', adminId: 'test-admin-id', memberCount: 0,
      workspaceId: 'test-workspace',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    projectId = ref.id;

    await db.collection('users').doc(memberId).set({
      email: 'member@test.com', displayName: 'Test Member', role: 'user',
      workspaceId: 'test-workspace',
      createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      schemaVersion: 1,
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
