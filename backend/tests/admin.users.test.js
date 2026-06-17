// ─────────────────────────────────────────────────────────────────
// admin.users.test.js — Sprint 5 tasks 5.10 + /me endpoint
//
// Strategy: same Firestore mock pattern as admin.projects.test.js
// Run: node --test tests/admin.users.test.js
// ─────────────────────────────────────────────────────────────────
'use strict';

const { describe, it, before, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');

// ─── Firestore mock (same as admin.projects.test.js) ──────────────
const store = {};

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
    this._col = col; this._filters = filters;
    this._order = order; this._limit = lim;
  }
  where(field, op, value) {
    return new MockQuery(this._col, [...this._filters, { field, op, value }], this._order, this._limit);
  }
  orderBy(field, dir = 'asc') {
    return new MockQuery(this._col, this._filters, { field, dir }, this._limit);
  }
  limit(n) { return new MockQuery(this._col, this._filters, this._order, n); }
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

const FieldValue = { increment: (n) => ({ __increment: n }) };

class MockFirestore {
  collection(col) { return new MockCollectionRef(col); }
  batch()         { return new MockBatch(); }
  async runTransaction(fn) {
    const tx = {
      async get(ref)    { return ref.get(); },
      set(ref, data)    { store[storeKey(ref._col, ref._id)] = { ...data }; },
      update(ref, data) {
        const key = storeKey(ref._col, ref._id);
        if (!store[key]) throw new Error('NOT_FOUND');
        const merged = { ...store[key] };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && v.__increment !== undefined) {
            merged[k] = (merged[k] || 0) + v.__increment;
          } else { merged[k] = v; }
        }
        store[key] = merged;
      },
      delete(ref) { delete store[storeKey(ref._col, ref._id)]; }
    };
    await fn(tx);
  }
}

const firestoreModuleName = '@google-cloud/firestore';
if (!require.cache[require.resolve(firestoreModuleName)]) {
  require.cache[require.resolve(firestoreModuleName)] = {
    id: require.resolve(firestoreModuleName),
    filename: require.resolve(firestoreModuleName),
    loaded: true,
    exports: { Firestore: MockFirestore, FieldValue }
  };
}

const gcsModuleName = '@google-cloud/storage';
if (!require.cache[require.resolve(gcsModuleName)]) {
  require.cache[require.resolve(gcsModuleName)] = {
    id: require.resolve(gcsModuleName),
    filename: require.resolve(gcsModuleName),
    loaded: true,
    exports: { Storage: class { bucket() { return { file() { return { getSignedUrl: async () => ['https://mock-url'] }; } }; } } }
  };
}

process.env.FIRESTORE_ENABLED = 'true';
process.env.API_KEY            = 'test-api-key';
process.env.GCS_BUCKET         = 'test-bucket';

// Load app — will reuse cached module if admin.projects.test.js ran first in same process
let appModule;
try {
  // Try resolving from cache (when tests run together via node --test tests/**/*.test.js)
  appModule = require('../src/index.js');
} catch (_) {
  appModule = require('../src/index.js');
}
const { app } = appModule;

// ─── Helpers ────────────────────────────────────────────────────
const ADMIN_EMAIL   = 'admin@users-test.com';
const ADMIN_USER_ID = 'usr_admin_users_001';

function seedAdmin() {
  store[`users/${ADMIN_USER_ID}`] = {
    email: ADMIN_EMAIL, role: 'admin', displayName: 'Admin User',
    createdAt: new Date().toISOString(), schemaVersion: 1
  };
}

function authed(req) {
  return req.set('X-Goog-Authenticated-User-Email', `accounts.google.com:${ADMIN_EMAIL}`);
}

function seedUser(id, overrides = {}) {
  const now = new Date().toISOString();
  store[`users/${id}`] = {
    email:         `${id}@test.com`,
    role:          'user',
    displayName:   `User ${id}`,
    createdAt:     now,
    schemaVersion: 1,
    ...overrides
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('GET /me', () => {

  before(() => seedAdmin());

  it('200 — returns provisioned user identity', async () => {
    const res = await authed(request(app).get('/me'));
    assert.equal(res.status, 200);
    assert.equal(res.body.email, ADMIN_EMAIL);
    assert.equal(res.body.role, 'admin');
    assert.equal(res.body.provisioned, true);
  });

  it('200 — unprovisioned IAP user returns provisioned:false', async () => {
    const res = await request(app).get('/me')
      .set('X-Goog-Authenticated-User-Email', 'accounts.google.com:ghost@nowhere.com');
    assert.equal(res.status, 200);
    assert.equal(res.body.provisioned, false);
    assert.equal(res.body.role, null);
  });

  it('401 — no IAP header', async () => {
    const res = await request(app).get('/me');
    assert.equal(res.status, 401);
  });

});

describe('GET /admin/users (5.10)', () => {

  beforeEach(() => {
    // Clear non-admin users between tests
    for (const k of Object.keys(store)) {
      if (k.startsWith('users/') && !k.includes(ADMIN_USER_ID)) delete store[k];
      if (k.startsWith('project') || k.startsWith('project_memberships')) delete store[k];
    }
    seedAdmin();
  });

  it('200 — returns empty array when no other users', async () => {
    const res = await authed(request(app).get('/admin/users'));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    // Admin user is seeded, so at least 1 result
    assert.ok(res.body.length >= 1);
  });

  it('200 — returns all seeded users', async () => {
    seedUser('usr_a1');
    seedUser('usr_a2');
    const res = await authed(request(app).get('/admin/users'));
    assert.equal(res.status, 200);
    const ids = res.body.map(u => u.userId);
    assert.ok(ids.includes('usr_a1'));
    assert.ok(ids.includes('usr_a2'));
  });

  it('200 — role filter narrows results', async () => {
    seedUser('usr_analyst_1', { role: 'analyst' });
    seedUser('usr_plain_1',   { role: 'user' });
    const res = await authed(request(app).get('/admin/users?role=analyst'));
    assert.equal(res.status, 200);
    assert.ok(res.body.every(u => u.role === 'analyst'));
    const ids = res.body.map(u => u.userId);
    assert.ok(ids.includes('usr_analyst_1'));
    assert.ok(!ids.includes('usr_plain_1'));
  });

  it('200 — projectId filter returns only members of that project', async () => {
    seedUser('usr_member_1');
    seedUser('usr_nonmember_1');
    const projectId = 'proj_filter_test';
    store[`projects/${projectId}`] = {
      name: 'Filter Test Project', adminId: ADMIN_USER_ID,
      memberCount: 1, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), schemaVersion: 1
    };
    store[`project_memberships/${projectId}_usr_member_1`] = {
      projectId, userId: 'usr_member_1', role: 'user',
      admittedAt: new Date().toISOString(), admittedBy: ADMIN_USER_ID, schemaVersion: 1
    };

    const res = await authed(request(app).get(`/admin/users?projectId=${projectId}`));
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].userId, 'usr_member_1');
    assert.ok(res.body[0].membership, 'membership field must be present');
    assert.equal(res.body[0].membership.role, 'user');
  });

  it('401 — no IAP header', async () => {
    const res = await request(app).get('/admin/users');
    assert.equal(res.status, 401);
  });

});

describe('GET /admin/users/:id (5.10)', () => {

  before(() => seedAdmin());

  it('200 — returns a single user', async () => {
    const uid = 'usr_single_fetch';
    seedUser(uid, { displayName: 'Single Fetch User' });
    const res = await authed(request(app).get(`/admin/users/${uid}`));
    assert.equal(res.status, 200);
    assert.equal(res.body.userId, uid);
    assert.equal(res.body.displayName, 'Single Fetch User');
  });

  it('404 — unknown user', async () => {
    const res = await authed(request(app).get('/admin/users/does-not-exist'));
    assert.equal(res.status, 404);
  });

});
