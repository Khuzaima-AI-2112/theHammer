// ─────────────────────────────────────────────────────────────────
// admin.projects.test.js — Sprint 5 tasks 5.2–5.8
//
// Strategy: mock Firestore at module level so no live GCP credentials
// are required in CI. The mock is injected before app is loaded by
// overriding require('@google-cloud/firestore') in the module cache.
//
// Run: node --test tests/admin.projects.test.js
// ─────────────────────────────────────────────────────────────────
'use strict';

const { describe, it, before, beforeEach, after } = require('node:test');
const assert   = require('node:assert/strict');
const request  = require('supertest');
const Module   = require('node:module');

// ─── Firestore mock ────────────────────────────────────────────────
// Thin in-memory store; supports .doc(), .collection(), .where(),
// .orderBy(), .limit(), .get(), .set(), .update(), .delete(),
// .batch(), and .runTransaction().

const store = {}; // { 'collection/docId': data }

function storeKey(col, id) { return `${col}/${id}`; }

class MockDocRef {
  constructor(col, id) {
    this._col = col;
    this._id  = id || crypto.randomUUID().replace(/-/g, '');
  }
  get id() { return this._id; }
  async get() {
    const data = store[storeKey(this._col, this._id)];
    return { exists: !!data, id: this._id, data: () => data || null, ref: this };
  }
  async set(data)    { store[storeKey(this._col, this._id)] = { ...data }; }
  async update(data) {
    const key = storeKey(this._col, this._id);
    if (!store[key]) throw new Error('NOT_FOUND');
    // Handle FieldValue.increment
    const merged = { ...store[key] };
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && v.__increment !== undefined) {
        merged[k] = (merged[k] || 0) + v.__increment;
      } else {
        merged[k] = v;
      }
    }
    store[key] = merged;
  }
  async delete() { delete store[storeKey(this._col, this._id)]; }
}

class MockQuery {
  constructor(col, filters = [], order = null, lim = 500) {
    this._col     = col;
    this._filters = filters;
    this._order   = order;
    this._limit   = lim;
  }
  where(field, op, value) {
    return new MockQuery(this._col, [...this._filters, { field, op, value }], this._order, this._limit);
  }
  orderBy(field, dir = 'asc') {
    return new MockQuery(this._col, this._filters, { field, dir }, this._limit);
  }
  limit(n) {
    return new MockQuery(this._col, this._filters, this._order, n);
  }
  async get() {
    const prefix = this._col + '/';
    let docs = Object.entries(store)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => ({ id: k.slice(prefix.length), data: () => ({ ...v }), ref: new MockDocRef(this._col, k.slice(prefix.length)) }));

    for (const f of this._filters) {
      docs = docs.filter(d => {
        const v = d.data()[f.field];
        if (f.op === '==') return v === f.value;
        return true;
      });
    }
    if (this._order) {
      const { field, dir } = this._order;
      docs.sort((a, b) => {
        const av = a.data()[field] || '';
        const bv = b.data()[field] || '';
        return dir === 'desc' ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
      });
    }
    docs = docs.slice(0, this._limit);
    return { docs, empty: docs.length === 0 };
  }
}

class MockCollectionRef extends MockQuery {
  constructor(col) { super(col); }
  doc(id) { return new MockDocRef(this._col, id); }
}

class MockBatch {
  constructor() { this._ops = []; }
  set(ref, data)    { this._ops.push(() => ref.set(data)); }
  update(ref, data) { this._ops.push(() => ref.update(data)); }
  delete(ref)       { this._ops.push(() => ref.delete()); }
  async commit()    { for (const op of this._ops) await op(); }
}

const FieldValue = {
  increment: (n) => ({ __increment: n })
};

class MockFirestore {
  collection(col) { return new MockCollectionRef(col); }
  batch()         { return new MockBatch(); }
  async runTransaction(fn) {
    // Simplified: no retry, no isolation — sufficient for unit tests
    const tx = {
      async get(ref)       { return ref.get(); },
      set(ref, data)       { store[storeKey(ref._col, ref._id)] = { ...data }; },
      update(ref, data)    {
        const key = storeKey(ref._col, ref._id);
        if (!store[key]) throw new Error('NOT_FOUND');
        const merged = { ...store[key] };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && v.__increment !== undefined) {
            merged[k] = (merged[k] || 0) + v.__increment;
          } else {
            merged[k] = v;
          }
        }
        store[key] = merged;
      },
      delete(ref)          { delete store[storeKey(ref._col, ref._id)]; }
    };
    await fn(tx);
  }
}

// Patch require cache before loading app
const firestoreModuleName = '@google-cloud/firestore';
require.cache[require.resolve(firestoreModuleName)] = {
  id:       require.resolve(firestoreModuleName),
  filename: require.resolve(firestoreModuleName),
  loaded:   true,
  exports:  { Firestore: MockFirestore, FieldValue }
};

// Also stub GCS so the app doesn't try to connect
const gcsModuleName = '@google-cloud/storage';
require.cache[require.resolve(gcsModuleName)] = {
  id:       require.resolve(gcsModuleName),
  filename: require.resolve(gcsModuleName),
  loaded:   true,
  exports:  { Storage: class { bucket() { return { file() { return { getSignedUrl: async () => ['https://mock-url'] }; } }; } } }
};

// Set env before loading app
process.env.FIRESTORE_ENABLED = 'true';
process.env.API_KEY            = 'test-api-key';
process.env.GCS_BUCKET         = 'test-bucket';

const { app } = require('../src/index.js');

// ─── Seed helper ───────────────────────────────────────────────────
// Simulates what the auth middleware resolves:
// inject X-Goog-Authenticated-User-Email and pre-seed an admin user.

const ADMIN_EMAIL  = 'admin@test.com';
const ADMIN_USER_ID = 'usr_admin_001';

function seedAdminUser() {
  store[`users/${ADMIN_USER_ID}`] = {
    email: ADMIN_EMAIL, role: 'admin', displayName: 'Test Admin',
    createdAt: new Date().toISOString(), schemaVersion: 1
  };
}

function authed(req) {
  return req.set('X-Goog-Authenticated-User-Email', `accounts.google.com:${ADMIN_EMAIL}`);
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('Admin Projects API (5.2–5.8)', () => {

  before(() => seedAdminUser());

  beforeEach(() => {
    // Clear non-user store entries between tests
    for (const k of Object.keys(store)) {
      if (!k.startsWith('users/')) delete store[k];
    }
    seedAdminUser();
  });

  // ── 5.2 POST /admin/projects ─────────────────────────────────────
  describe('POST /admin/projects', () => {
    it('201 — creates a project and returns projectId + name', async () => {
      const res = await authed(request(app).post('/admin/projects'))
        .send({ name: 'Test Project Alpha' })
        .set('Content-Type', 'application/json');
      assert.equal(res.status, 201);
      assert.ok(res.body.projectId, 'projectId must be present');
      assert.equal(res.body.name, 'Test Project Alpha');
      assert.ok(res.body.createdAt);
    });

    it('400 — rejects missing name', async () => {
      const res = await authed(request(app).post('/admin/projects'))
        .send({})
        .set('Content-Type', 'application/json');
      assert.equal(res.status, 400);
      assert.match(res.body.error, /name is required/);
    });

    it('400 — rejects whitespace-only name', async () => {
      const res = await authed(request(app).post('/admin/projects'))
        .send({ name: '   ' })
        .set('Content-Type', 'application/json');
      assert.equal(res.status, 400);
    });

    it('401 — rejects request without IAP header', async () => {
      const res = await request(app).post('/admin/projects')
        .send({ name: 'No Auth' })
        .set('Content-Type', 'application/json');
      assert.equal(res.status, 401);
    });

    it('name is trimmed and capped at 128 chars', async () => {
      const longName = 'A'.repeat(200);
      const res = await authed(request(app).post('/admin/projects'))
        .send({ name: longName })
        .set('Content-Type', 'application/json');
      assert.equal(res.status, 201);
      assert.equal(res.body.name.length, 128);
    });
  });

  // ── 5.3 GET /admin/projects ──────────────────────────────────────
  describe('GET /admin/projects', () => {
    it('200 — returns array (empty when no projects)', async () => {
      const res = await authed(request(app).get('/admin/projects'));
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });

    it('200 — returns created project in list', async () => {
      await authed(request(app).post('/admin/projects'))
        .send({ name: 'Listed Project' })
        .set('Content-Type', 'application/json');

      const res = await authed(request(app).get('/admin/projects'));
      assert.equal(res.status, 200);
      assert.ok(res.body.some(p => p.name === 'Listed Project'));
    });
  });

  // ── 5.4 GET /admin/projects/:id ──────────────────────────────────
  describe('GET /admin/projects/:id', () => {
    it('200 — returns a single project', async () => {
      const created = await authed(request(app).post('/admin/projects'))
        .send({ name: 'Fetchable Project' })
        .set('Content-Type', 'application/json');
      const { projectId } = created.body;

      const res = await authed(request(app).get(`/admin/projects/${projectId}`));
      assert.equal(res.status, 200);
      assert.equal(res.body.projectId, projectId);
      assert.equal(res.body.name, 'Fetchable Project');
    });

    it('404 — unknown project', async () => {
      const res = await authed(request(app).get('/admin/projects/does-not-exist'));
      assert.equal(res.status, 404);
    });
  });

  // ── 5.5 PATCH /admin/projects/:id ────────────────────────────────
  describe('PATCH /admin/projects/:id', () => {
    it('200 — renames a project', async () => {
      const created = await authed(request(app).post('/admin/projects'))
        .send({ name: 'Old Name' })
        .set('Content-Type', 'application/json');
      const { projectId } = created.body;

      const res = await authed(request(app).patch(`/admin/projects/${projectId}`))
        .send({ name: 'New Name' })
        .set('Content-Type', 'application/json');
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'New Name');
    });

    it('400 — empty body', async () => {
      const created = await authed(request(app).post('/admin/projects'))
        .send({ name: 'Patch Target' })
        .set('Content-Type', 'application/json');
      const res = await authed(request(app).patch(`/admin/projects/${created.body.projectId}`))
        .send({})
        .set('Content-Type', 'application/json');
      assert.equal(res.status, 400);
    });

    it('404 — unknown project', async () => {
      const res = await authed(request(app).patch('/admin/projects/ghost'))
        .send({ name: 'Ghost' })
        .set('Content-Type', 'application/json');
      assert.equal(res.status, 404);
    });
  });

  // ── 5.6 DELETE /admin/projects/:id ───────────────────────────────
  describe('DELETE /admin/projects/:id', () => {
    it('204 — deletes a project', async () => {
      const created = await authed(request(app).post('/admin/projects'))
        .send({ name: 'Doomed Project' })
        .set('Content-Type', 'application/json');
      const { projectId } = created.body;

      const del = await authed(request(app).delete(`/admin/projects/${projectId}`));
      assert.equal(del.status, 204);

      const get = await authed(request(app).get(`/admin/projects/${projectId}`));
      assert.equal(get.status, 404);
    });

    it('404 — unknown project', async () => {
      const res = await authed(request(app).delete('/admin/projects/ghost'));
      assert.equal(res.status, 404);
    });
  });

  // ── 5.7 POST /admin/projects/:id/members ─────────────────────────
  describe('POST /admin/projects/:id/members', () => {
    it('201 — admits a user', async () => {
      const created = await authed(request(app).post('/admin/projects'))
        .send({ name: 'Membership Project' })
        .set('Content-Type', 'application/json');
      const { projectId } = created.body;

      // Seed a target user
      const targetUserId = 'usr_target_001';
      store[`users/${targetUserId}`] = { email: 'user@test.com', role: 'user', schemaVersion: 1 };

      const res = await authed(request(app).post(`/admin/projects/${projectId}/members`))
        .send({ userId: targetUserId, role: 'user' })
        .set('Content-Type', 'application/json');
      assert.equal(res.status, 201);
      assert.equal(res.body.userId, targetUserId);

      // memberCount should now be 1
      const proj = await authed(request(app).get(`/admin/projects/${projectId}`));
      assert.equal(proj.body.memberCount, 1);
    });

    it('409 — duplicate membership', async () => {
      const created = await authed(request(app).post('/admin/projects'))
        .send({ name: 'Dupe Test' })
        .set('Content-Type', 'application/json');
      const { projectId } = created.body;
      const targetUserId = 'usr_dupe_001';
      store[`users/${targetUserId}`] = { email: 'dupe@test.com', role: 'user', schemaVersion: 1 };

      await authed(request(app).post(`/admin/projects/${projectId}/members`))
        .send({ userId: targetUserId, role: 'user' })
        .set('Content-Type', 'application/json');

      const res = await authed(request(app).post(`/admin/projects/${projectId}/members`))
        .send({ userId: targetUserId, role: 'user' })
        .set('Content-Type', 'application/json');
      assert.equal(res.status, 409);
    });

    it('400 — missing userId', async () => {
      const created = await authed(request(app).post('/admin/projects'))
        .send({ name: 'Missing userId' })
        .set('Content-Type', 'application/json');
      const res = await authed(request(app).post(`/admin/projects/${created.body.projectId}/members`))
        .send({ role: 'user' })
        .set('Content-Type', 'application/json');
      assert.equal(res.status, 400);
    });

    it('400 — invalid role', async () => {
      const created = await authed(request(app).post('/admin/projects'))
        .send({ name: 'Bad Role' })
        .set('Content-Type', 'application/json');
      const res = await authed(request(app).post(`/admin/projects/${created.body.projectId}/members`))
        .send({ userId: 'usr_x', role: 'superuser' })
        .set('Content-Type', 'application/json');
      assert.equal(res.status, 400);
    });
  });

  // ── 5.8 DELETE /admin/projects/:id/members/:userId ────────────────
  describe('DELETE /admin/projects/:id/members/:userId', () => {
    it('204 — removes a member and decrements memberCount', async () => {
      const created = await authed(request(app).post('/admin/projects'))
        .send({ name: 'Remove Member' })
        .set('Content-Type', 'application/json');
      const { projectId } = created.body;
      const targetUserId  = 'usr_remove_001';
      store[`users/${targetUserId}`] = { email: 'remove@test.com', role: 'user', schemaVersion: 1 };

      await authed(request(app).post(`/admin/projects/${projectId}/members`))
        .send({ userId: targetUserId, role: 'user' })
        .set('Content-Type', 'application/json');

      const del = await authed(request(app).delete(`/admin/projects/${projectId}/members/${targetUserId}`));
      assert.equal(del.status, 204);

      // memberCount back to 0
      const proj = await authed(request(app).get(`/admin/projects/${projectId}`));
      assert.equal(proj.body.memberCount, 0);
    });

    it('404 — membership not found', async () => {
      const created = await authed(request(app).post('/admin/projects'))
        .send({ name: 'No Member' })
        .set('Content-Type', 'application/json');
      const res = await authed(request(app).delete(`/admin/projects/${created.body.projectId}/members/ghost_user`));
      assert.equal(res.status, 404);
    });
  });

});
