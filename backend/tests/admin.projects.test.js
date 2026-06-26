/**
 * Sprint 5.2–5.5  —  /admin/projects routes
 *
 * Test runner: Jest
 * Firestore:   Firestore Emulator  (FIRESTORE_EMULATOR_HOST=127.0.0.1:8080)
 * Auth shim:   X-Dev-User-Email (requireRole dev fallback, NODE_ENV=test)
 */

'use strict';

process.env.NODE_ENV                = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';

const request = require('supertest');
const { clearDatabase, seedUser, seedProject } = require('./helpers/fixtures');

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
      memberCount:   0,
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

  test('404 — non-existent project', async () => {
    const res = await request(app)
      .patch('/admin/projects/does-not-exist-xyz')
      .set(H)
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
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

  test('404 — non-existent project', async () => {
    const res = await request(app).delete('/admin/projects/ghost-project-xyz').set(H);
    expect(res.status).toBe(404);
  });
});
