/**
 * Sprint 5.2–5.5  —  Unit test skeleton for /admin/projects routes.
 *
 * Test runner: Jest  (already in devDependencies via package.json)
 * Firestore:   Use the Firestore Emulator.
 *              Start with:  firebase emulators:start --only firestore
 *              Set env:     FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
 *
 * Run:  npm test  (from backend/)
 *
 * These tests use supertest to fire HTTP requests against the real Express app
 * with a dev IAP header (X-Dev-User-Email) so requireAdmin resolves against
 * the emulator.
 */

'use strict';

process.env.NODE_ENV             = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';

const request = require('supertest');

// Import app AFTER setting env vars
let app;
let db;

beforeAll(async () => {
  // Dynamic import so env vars are set first
  app = require('../src/index');
  db  = require('../src/lib/firestore').db;

  // Seed a test admin user into the emulator
  await db.collection('users').doc('test-admin-id').set({
    email:         'admin@test.com',
    displayName:   'Test Admin',
    role:          'admin',
    createdAt:     new Date().toISOString(),
    lastActiveAt:  new Date().toISOString(),
    schemaVersion: 1,
  });
});

afterAll(async () => {
  // Clean up seeded data
  await db.collection('users').doc('test-admin-id').delete();
});

const adminHeaders = {
  'x-dev-user-email': 'admin@test.com',
  'content-type':     'application/json',
};

describe('POST /admin/projects', () => {
  let createdId;

  afterEach(async () => {
    if (createdId) {
      await db.collection('projects').doc(createdId).delete();
      createdId = null;
    }
  });

  test('201 — creates a project with valid name', async () => {
    const res = await request(app)
      .post('/admin/projects')
      .set(adminHeaders)
      .send({ name: 'Test Project Alpha' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name:          'Test Project Alpha',
      adminId:       'test-admin-id',
      memberCount:   0,
      schemaVersion: 1,
    });
    expect(res.body.id).toBeTruthy();
    createdId = res.body.id;
  });

  test('400 — rejects empty name', async () => {
    const res = await request(app)
      .post('/admin/projects')
      .set(adminHeaders)
      .send({ name: '' });
    expect(res.status).toBe(400);
  });

  test('400 — rejects name > 128 chars', async () => {
    const res = await request(app)
      .post('/admin/projects')
      .set(adminHeaders)
      .send({ name: 'x'.repeat(129) });
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
  let pid;

  beforeAll(async () => {
    const ref = await db.collection('projects').add({
      name: 'GET Test Project',
      adminId: 'test-admin-id',
      memberCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    pid = ref.id;
  });

  afterAll(async () => {
    await db.collection('projects').doc(pid).delete();
  });

  test('200 — returns projects array', async () => {
    const res = await request(app)
      .get('/admin/projects')
      .set(adminHeaders);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.projects)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });
});

describe('PATCH /admin/projects/:id', () => {
  let pid;

  beforeEach(async () => {
    const ref = await db.collection('projects').add({
      name: 'Original Name',
      adminId: 'test-admin-id',
      memberCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    pid = ref.id;
  });

  afterEach(async () => {
    await db.collection('projects').doc(pid).delete().catch(() => {});
  });

  test('200 — renames project', async () => {
    const res = await request(app)
      .patch(`/admin/projects/${pid}`)
      .set(adminHeaders)
      .send({ name: 'Renamed Project' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed Project');
  });

  test('404 — non-existent project', async () => {
    const res = await request(app)
      .patch('/admin/projects/does-not-exist-xyz')
      .set(adminHeaders)
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /admin/projects/:id', () => {
  test('204 — deletes project and memberships', async () => {
    const ref = await db.collection('projects').add({
      name: 'To Delete',
      adminId: 'test-admin-id',
      memberCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    const res = await request(app)
      .delete(`/admin/projects/${ref.id}`)
      .set(adminHeaders);
    expect(res.status).toBe(204);

    // Verify gone
    const check = await db.collection('projects').doc(ref.id).get();
    expect(check.exists).toBe(false);
  });

  test('404 — non-existent project', async () => {
    const res = await request(app)
      .delete('/admin/projects/ghost-project-xyz')
      .set(adminHeaders);
    expect(res.status).toBe(404);
  });
});
