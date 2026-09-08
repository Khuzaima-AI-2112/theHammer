/**
 * Storyboard drafts (#85) — curate and persist a Capture selection
 *
 * POST  /admin/projects/:id/storyboards  — find-or-create the Project's
 *                                           open draft
 * GET   /admin/storyboards/:id           — fetch a draft
 * PATCH /admin/storyboards/:id           — update checkboxes/order/notes
 *
 * A draft is pre-populated once, at creation, with every Capture the
 * Project has at that moment, oldest first — same ordering
 * project-export.test.js already covers for the ZIP export. Firestore:
 * emulator. Cloud Storage: mocked — no network.
 */
'use strict';

const request = require('supertest');

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock({
  signedUrlPrefix: 'https://storage.googleapis.com/fake-bucket/'
}));

process.env.GCS_BUCKET = 'fake-bucket';

const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const collections = require('../src/lib/collections');
const { clearDatabase, seedUser, seedProject, HEADERS } = require('./helpers/fixtures');

async function seedUpload(id, projectId, data = {}) {
  await db.collection(collections.UPLOADS).doc(id).set({
    projectId,
    userId: 'analyst-fixture-id',
    tool: 'Softomedia',
    stage: 'media-buyer',
    tabUrl: 'https://softomedia.example/campaigns',
    path: `${projectId}/${id}.png`,
    gcsPath: `${projectId}/${id}.png`,
    bucket: 'fake-bucket',
    size: 1234,
    hasSemanticData: false,
    schemaVersion: 1,
    ...data
  });
}

beforeAll(async () => {
  await clearDatabase();
  await seedUser('admin-fixture-id', { email: 'admin-fixture@test.com', role: 'admin' });
  await seedUser('analyst-fixture-id', { email: 'analyst-fixture@test.com', role: 'analyst' });
  await seedUser('user-fixture-id', { email: 'user-fixture@test.com', role: 'user' });
  await seedProject('draft-proj', { name: 'Storyboard Draft Project' });
  await seedProject('draft-proj-foreign', { name: 'Other tenant', workspaceId: 'other-workspace' });
});

afterAll(async () => {
  await clearDatabase();
});

describe('POST /admin/projects/:id/storyboards', () => {
  beforeAll(async () => {
    // Seeded out of order on purpose: creation must sort by capture time,
    // not trust insertion order or Firestore's default ordering.
    await seedUpload('draft-cap-b', 'draft-proj', { uploadedAt: '2026-09-01T09:05:00.000Z' });
    await seedUpload('draft-cap-c', 'draft-proj', { uploadedAt: '2026-09-01T09:11:30.000Z' });
    await seedUpload('draft-cap-a', 'draft-proj', { uploadedAt: '2026-09-01T09:00:00.000Z' });
  });

  afterAll(async () => {
    for (const id of ['draft-cap-a', 'draft-cap-b', 'draft-cap-c']) {
      await db.collection(collections.UPLOADS).doc(id).delete();
    }
    const snap = await db.collection(collections.STORYBOARD_DRAFTS)
      .where('projectId', '==', 'draft-proj').get();
    for (const doc of snap.docs) await doc.ref.delete();
  });

  // #99: same answer as the foreign-Project case below, deliberately. A draft
  // that does not exist is still a 404 — that is a Storyboard, not a Project.
  test('403 — project does not exist', async () => {
    const res = await request(app)
      .post('/admin/projects/no-such-project/storyboards')
      .set(HEADERS.analyst);
    expect(res.status).toBe(403);
  });

  test('403 — project belongs to another workspace', async () => {
    const res = await request(app)
      .post('/admin/projects/draft-proj-foreign/storyboards')
      .set(HEADERS.analyst);
    expect(res.status).toBe(403);
  });

  test('403 — a plain user cannot create a draft', async () => {
    const res = await request(app)
      .post('/admin/projects/draft-proj/storyboards')
      .set(HEADERS.user);
    expect(res.status).toBe(403);
  });

  describe('role gating admits Analyst and Admin', () => {
    afterEach(async () => {
      const snap = await db.collection(collections.STORYBOARD_DRAFTS)
        .where('projectId', '==', 'draft-proj').get();
      for (const doc of snap.docs) await doc.ref.delete();
    });

    test('201 — an Analyst can create a draft', async () => {
      const res = await request(app)
        .post('/admin/projects/draft-proj/storyboards')
        .set(HEADERS.analyst);
      expect(res.status).toBe(201);
    });

    test('201 — an Admin can create a draft (admin outranks analyst)', async () => {
      const res = await request(app)
        .post('/admin/projects/draft-proj/storyboards')
        .set(HEADERS.admin);
      expect(res.status).toBe(201);
    });
  });

  describe('a fresh draft', () => {
    let draft;

    beforeAll(async () => {
      const res = await request(app)
        .post('/admin/projects/draft-proj/storyboards')
        .set(HEADERS.analyst);
      draft = res.body;
    });

    afterAll(async () => {
      await db.collection(collections.STORYBOARD_DRAFTS).doc(draft.id).delete();
    });

    test('pre-populates every Capture, oldest first', () => {
      expect(draft.captures.map(c => c.captureId)).toEqual([
        'draft-cap-a', 'draft-cap-b', 'draft-cap-c'
      ]);
      expect(draft.captures.map(c => c.order)).toEqual([1, 2, 3]);
    });

    test('every Capture starts included, with an empty note', () => {
      expect(draft.captures.every(c => c.included === true)).toBe(true);
      expect(draft.captures.every(c => c.note === '')).toBe(true);
    });

    test('each Capture carries a signed thumbnail URL', () => {
      expect(draft.captures.every(c => typeof c.signedUrl === 'string' && c.signedUrl.length > 0)).toBe(true);
    });

    // #111, ADR 0014 — the draft is stamped with the *Project's* Workspace, and
    // never with the caller's own. Read back from Firestore because the field
    // does not reach the response, and compared against the Project's stored
    // value rather than a literal, in the same shape as the #103 assertion in
    // storyboard-finalize.test.js — so the fixture default cannot make it pass
    // by coincidence.
    //
    // Note what this test can and cannot catch. `loadOwnedProject` admits the
    // request only when the two Workspaces are already equal, so no request
    // this suite can send makes the wrong source produce a wrong value: the bug
    // #111 fixes is latent, not live, and this assertion passes either side of
    // the fix. It locks the property, over the real route, for the day a caller
    // can reach a Project in a Workspace that is not their own. The test that
    // actually goes red without the fix stands at the seam instead, in
    // storyboard-draft-workspace-source.test.js — the two are a pair, and
    // neither is worth much alone.
    test("stamps the draft with the Project's Workspace, not the caller's", async () => {
      const projectSnap = await db.collection(collections.PROJECTS).doc('draft-proj').get();
      expect(projectSnap.data().workspaceId).toBeTruthy();

      const draftSnap = await db.collection(collections.STORYBOARD_DRAFTS).doc(draft.id).get();
      expect(draftSnap.data().workspaceId).toBe(projectSnap.data().workspaceId);
    });

    test('re-opening the same Project returns the same draft, not a new one', async () => {
      const res = await request(app)
        .post('/admin/projects/draft-proj/storyboards')
        .set(HEADERS.analyst);
      expect(res.status).toBe(200); // found existing, not 201 created
      expect(res.body.id).toBe(draft.id);
    });
  });
});

describe('GET /admin/storyboards/:id', () => {
  let draft;

  beforeAll(async () => {
    await seedUpload('get-cap-a', 'draft-proj', { uploadedAt: '2026-09-01T10:00:00.000Z' });
    const res = await request(app)
      .post('/admin/projects/draft-proj/storyboards')
      .set(HEADERS.analyst);
    draft = res.body;
  });

  afterAll(async () => {
    await db.collection(collections.UPLOADS).doc('get-cap-a').delete();
    await db.collection(collections.STORYBOARD_DRAFTS).doc(draft.id).delete();
  });

  test('404 — no such draft', async () => {
    const res = await request(app)
      .get('/admin/storyboards/no-such-draft')
      .set(HEADERS.analyst);
    expect(res.status).toBe(404);
  });

  test('200 — fetches the draft by id', async () => {
    const res = await request(app)
      .get(`/admin/storyboards/${draft.id}`)
      .set(HEADERS.analyst);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(draft.id);
    expect(res.body.projectId).toBe('draft-proj');
  });

  test('403 — a plain user cannot fetch a draft', async () => {
    const res = await request(app)
      .get(`/admin/storyboards/${draft.id}`)
      .set(HEADERS.user);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /admin/storyboards/:id', () => {
  let draft;

  beforeEach(async () => {
    await clearDatabase();
    await seedUser('admin-fixture-id', { email: 'admin-fixture@test.com', role: 'admin' });
    await seedUser('analyst-fixture-id', { email: 'analyst-fixture@test.com', role: 'analyst' });
    await seedUser('user-fixture-id', { email: 'user-fixture@test.com', role: 'user' });
    await seedProject('patch-proj', { name: 'Patch Project' });
    await seedUpload('patch-cap-a', 'patch-proj', { uploadedAt: '2026-09-01T09:00:00.000Z' });
    await seedUpload('patch-cap-b', 'patch-proj', { uploadedAt: '2026-09-01T09:05:00.000Z' });

    const res = await request(app)
      .post('/admin/projects/patch-proj/storyboards')
      .set(HEADERS.analyst);
    draft = res.body;
  });

  function reordered({ aIncluded = false, bIncluded = true, aNote = 'second, excluded' } = {}) {
    return {
      captures: [
        { captureId: 'patch-cap-b', order: 1, included: bIncluded, note: 'now first' },
        { captureId: 'patch-cap-a', order: 2, included: aIncluded, note: aNote },
      ]
    };
  }

  test('persists reordering, checkbox state, and notes', async () => {
    const patchRes = await request(app)
      .patch(`/admin/storyboards/${draft.id}`)
      .set(HEADERS.analyst)
      .send(reordered());
    expect(patchRes.status).toBe(200);

    // Fetch again — closing and reopening must restore exactly what was set.
    const getRes = await request(app)
      .get(`/admin/storyboards/${draft.id}`)
      .set(HEADERS.analyst);

    expect(getRes.body.captures.map(c => c.captureId)).toEqual(['patch-cap-b', 'patch-cap-a']);
    expect(getRes.body.captures[0]).toMatchObject({ included: true, note: 'now first' });
    expect(getRes.body.captures[1]).toMatchObject({ included: false, note: 'second, excluded' });
  });

  test('400 — rejects two Captures claiming the same slide number', async () => {
    const res = await request(app)
      .patch(`/admin/storyboards/${draft.id}`)
      .set(HEADERS.analyst)
      .send({
        captures: [
          { captureId: 'patch-cap-a', order: 1, included: true, note: '' },
          { captureId: 'patch-cap-b', order: 1, included: true, note: '' },
        ]
      });
    expect(res.status).toBe(400);
  });

  test('400 — rejects a captureId the draft was not created with', async () => {
    const res = await request(app)
      .patch(`/admin/storyboards/${draft.id}`)
      .set(HEADERS.analyst)
      .send({
        captures: [
          { captureId: 'patch-cap-a', order: 1, included: true, note: '' },
          { captureId: 'not-a-real-capture', order: 2, included: true, note: '' },
        ]
      });
    expect(res.status).toBe(400);
  });

  test('400 — rejects a partial set that drops a known Capture', async () => {
    const res = await request(app)
      .patch(`/admin/storyboards/${draft.id}`)
      .set(HEADERS.analyst)
      .send({ captures: [{ captureId: 'patch-cap-a', order: 1, included: true, note: '' }] });
    expect(res.status).toBe(400);
  });

  test('403 — a plain user cannot patch a draft', async () => {
    const res = await request(app)
      .patch(`/admin/storyboards/${draft.id}`)
      .set(HEADERS.user)
      .send(reordered());
    expect(res.status).toBe(403);
  });
});
