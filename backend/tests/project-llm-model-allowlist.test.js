/**
 * #108 — `llmModel` is refused unless the product actually supports it.
 *
 * POST and PATCH /admin/projects used to take
 * `(req.body?.llmModel ?? 'gemini-1.5-flash').trim()` and store whatever
 * arrived. Any string was a model id as far as this code was concerned, and
 * because #8 degrades gracefully, a bad one produced a finished Report with no
 * narrative rather than an error — the failure surfaced nowhere a person
 * looks. The allowlist moves that failure to the edge, where it is loud.
 *
 * Firestore: emulator. Cloud Storage: the shared double, because the Purge
 * half of this router constructs a bucket at require time.
 */
'use strict';

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock());

const request = require('supertest');
const { clearDatabase, seedUser } = require('./helpers/fixtures');
const { DEFAULT_LLM_MODEL, SUPPORTED_LLM_MODELS } = require('../src/lib/models');

let app, db;

beforeAll(async () => {
  app = require('../src/index').app;
  db  = require('../src/lib/firestore').db;
  await clearDatabase();
  await seedUser('admin-allowlist', { email: 'allowlist@test.com', role: 'admin' });
});

afterAll(async () => {
  await clearDatabase();
});

const H = { 'x-dev-user-email': 'allowlist@test.com', 'content-type': 'application/json' };

const created = [];
afterEach(async () => {
  while (created.length) {
    const id = created.pop();
    await db.collection('project_memberships').doc(`${id}_admin-allowlist`).delete().catch(() => {});
    await db.collection('projects').doc(id).delete().catch(() => {});
  }
});

async function createProject(body) {
  const res = await request(app).post('/admin/projects').set(H).send(body);
  if (res.status === 201) created.push(res.body.id);
  return res;
}

describe('POST /admin/projects', () => {
  test('201 — an allowlisted model is stored as sent', async () => {
    const res = await createProject({ name: 'Allowed', llmModel: 'gemini-2.5-pro' });

    expect(res.status).toBe(201);
    expect(res.body.llmModel).toBe('gemini-2.5-pro');
  });

  test('201 — omitting llmModel stores the supported default', async () => {
    const res = await createProject({ name: 'Defaulted' });

    expect(res.status).toBe(201);
    expect(res.body.llmModel).toBe(DEFAULT_LLM_MODEL);
  });

  test('400 — a retired model is refused, not stored', async () => {
    const res = await createProject({ name: 'Retired', llmModel: 'gemini-1.5-flash' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/llmModel must be one of/);

    const snap = await db.collection('projects').where('name', '==', 'Retired').get();
    expect(snap.empty).toBe(true);
  });

  test('400 — a real model that is not served in our region is refused', async () => {
    // gemini-3.6-flash exists and is GA; it 404s in northamerica-northeast1,
    // which is exactly the class of id an allowlist has to catch, because
    // nothing downstream can tell it apart from a working one.
    const res = await createProject({ name: 'Wrong region', llmModel: 'gemini-3.6-flash' });

    expect(res.status).toBe(400);
  });

  test('400 — arbitrary junk is refused', async () => {
    const res = await createProject({ name: 'Junk', llmModel: 'totally-made-up' });

    expect(res.status).toBe(400);
  });

  test('the error names the models that would work', async () => {
    const res = await createProject({ name: 'Helpful', llmModel: 'nope' });

    for (const supported of SUPPORTED_LLM_MODELS) {
      expect(res.body.error).toContain(supported);
    }
  });

  test('a bad name still takes precedence over a bad model', async () => {
    const res = await createProject({ name: '', llmModel: 'nope' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name must be/);
  });
});

describe('PATCH /admin/projects/:id', () => {
  test('200 — an allowlisted model replaces the stored one', async () => {
    const create = await createProject({ name: 'Patch me', llmModel: DEFAULT_LLM_MODEL });

    const res = await request(app)
      .patch(`/admin/projects/${create.body.id}`)
      .set(H)
      .send({ name: 'Patch me', llmModel: 'gemini-2.5-flash' });

    expect(res.status).toBe(200);
    expect(res.body.llmModel).toBe('gemini-2.5-flash');
  });

  test('400 — a retired model is refused, and the stored value is untouched', async () => {
    const create = await createProject({ name: 'Keep mine', llmModel: 'gemini-2.5-pro' });

    const res = await request(app)
      .patch(`/admin/projects/${create.body.id}`)
      .set(H)
      .send({ name: 'Keep mine', llmModel: 'gemini-1.5-flash' });

    expect(res.status).toBe(400);

    const after = await db.collection('projects').doc(create.body.id).get();
    expect(after.data().llmModel).toBe('gemini-2.5-pro');
  });
});
