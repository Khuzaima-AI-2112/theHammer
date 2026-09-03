/**
 * AI narrative generation from a Storyboard draft (#86)
 *
 * POST /admin/storyboards/:id/narrative takes a typed prompt, builds a
 * multimodal Gemini request from the draft's *included*, *ordered* Captures
 * (as gs:// image references) plus their notes, and writes the result back
 * onto the draft as narrativeStatus/narrativeText — not into the `reports`
 * collection (see storyboards.js's header comment and ADR 0013).
 *
 * Firestore: emulator. Cloud Storage: mocked (thumbnails only — the
 * narrative request references gs:// paths directly, no signed URL).
 * Vertex AI (`@google/genai`): mocked — no network, no real cost.
 */
'use strict';

const request = require('supertest');

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock({
  signedUrlPrefix: 'https://storage.googleapis.com/fake-bucket/'
}));
jest.mock('@google/genai', () => require('./helpers/genaiMock').createGenAIMock({
  text: 'Canned narrative: the Analyst opened the campaign, then saved it.'
}));

process.env.GCS_BUCKET = 'fake-bucket';

const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const { getAIClient } = require('../src/lib/vertex');
const storyboardsRouter = require('../src/routes/admin/storyboards');
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

async function createDraft(projectId, headers = HEADERS.analyst) {
  const res = await request(app)
    .post(`/admin/projects/${encodeURIComponent(projectId)}/storyboards`)
    .set(headers);
  return res.body;
}

/** Real-timer poll — the mocked Gemini call resolves almost immediately, but
 * generation still runs after the POST response is sent. */
async function pollUntilSettled(draftId, headers = HEADERS.analyst, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const res = await request(app).get(`/admin/storyboards/${draftId}`).set(headers);
    if (res.body.narrativeStatus === 'done' || res.body.narrativeStatus === 'error') {
      return res.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`narrative for draft ${draftId} never settled`);
}

beforeAll(async () => {
  await clearDatabase();
  await seedUser('admin-fixture-id', { email: 'admin-fixture@test.com', role: 'admin' });
  await seedUser('analyst-fixture-id', { email: 'analyst-fixture@test.com', role: 'analyst' });
  await seedUser('user-fixture-id', { email: 'user-fixture@test.com', role: 'user' });
  await seedProject('narrative-proj', { name: 'Narrative Project', llmModel: 'gemini-1.5-flash' });
  await seedProject('narrative-proj-foreign', { name: 'Other tenant', workspaceId: 'other-workspace' });
});

afterAll(async () => {
  await clearDatabase();
});

describe('buildNarrativeRequest', () => {
  let draft;

  beforeAll(async () => {
    await seedUpload('narr-cap-a', 'narrative-proj', { uploadedAt: '2026-09-01T09:00:00.000Z' });
    await seedUpload('narr-cap-b', 'narrative-proj', { uploadedAt: '2026-09-01T09:05:00.000Z' });
    await seedUpload('narr-cap-c', 'narrative-proj', { uploadedAt: '2026-09-01T09:10:00.000Z' });
    draft = await createDraft('narrative-proj');

    // Exclude the middle Capture and swap the order of the other two, so the
    // request has to reflect curation rather than upload order.
    await request(app)
      .patch(`/admin/storyboards/${draft.id}`)
      .set(HEADERS.analyst)
      .send({
        captures: [
          { captureId: 'narr-cap-c', order: 1, included: true, note: 'opening screen' },
          { captureId: 'narr-cap-b', order: 2, included: false, note: 'skip this one' },
          { captureId: 'narr-cap-a', order: 3, included: true, note: '' },
        ]
      });
  });

  afterAll(async () => {
    for (const id of ['narr-cap-a', 'narr-cap-b', 'narr-cap-c']) {
      await db.collection(collections.UPLOADS).doc(id).delete();
    }
    await db.collection(collections.STORYBOARD_DRAFTS).doc(draft.id).delete();
  });

  test('sends only included Captures, in slide order, as gs:// image parts with their notes', async () => {
    const getRes = await request(app).get(`/admin/storyboards/${draft.id}`).set(HEADERS.analyst);
    const curated = getRes.body;

    const req = await storyboardsRouter.buildNarrativeRequest(curated, 'Tell the story of this campaign.');
    const parts = req.contents[0].parts;

    expect(parts[0]).toEqual({ text: 'Tell the story of this campaign.' });

    // narr-cap-c (order 1, included) — image, then its note
    expect(parts[1]).toEqual({ fileData: { mimeType: 'image/png', fileUri: 'gs://fake-bucket/narrative-proj/narr-cap-c.png' } });
    expect(parts[2]).toEqual({ text: 'Slide 1 note: opening screen' });

    // narr-cap-b (excluded) never appears anywhere in the parts
    expect(parts.some((p) => p.fileData?.fileUri.includes('narr-cap-b'))).toBe(false);
    expect(parts.some((p) => p.text?.includes('skip this one'))).toBe(false);

    // narr-cap-a (order 3, included, no note) — image only, no stray note part
    expect(parts[3]).toEqual({ fileData: { mimeType: 'image/png', fileUri: 'gs://fake-bucket/narrative-proj/narr-cap-a.png' } });
    expect(parts).toHaveLength(4);
  });
});

describe('POST /admin/storyboards/:id/narrative', () => {
  let draft;

  beforeEach(async () => {
    await seedUpload('gen-cap-a', 'narrative-proj', { uploadedAt: '2026-09-01T09:00:00.000Z' });
    draft = await createDraft('narrative-proj');
  });

  afterEach(async () => {
    await db.collection(collections.UPLOADS).doc('gen-cap-a').delete();
    await db.collection(collections.STORYBOARD_DRAFTS).doc(draft.id).delete();
  });

  test('404 — no such draft', async () => {
    const res = await request(app)
      .post('/admin/storyboards/no-such-draft/narrative')
      .set(HEADERS.analyst)
      .send({ prompt: 'Summarize this.' });
    expect(res.status).toBe(404);
  });

  test('403 — draft belongs to another workspace', async () => {
    // Seeded directly rather than via POST /storyboards — that route's own
    // workspace check would refuse to create it under an analyst-fixture
    // header, since no fixture user lives in 'other-workspace'.
    const foreignRef = db.collection(collections.STORYBOARD_DRAFTS).doc();
    await foreignRef.set({
      projectId: 'narrative-proj-foreign',
      workspaceId: 'other-workspace',
      status: 'draft',
      captures: [],
      createdBy: 'someone-else',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    const res = await request(app)
      .post(`/admin/storyboards/${foreignRef.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ prompt: 'Summarize this.' });
    expect(res.status).toBe(403);
    await foreignRef.delete();
  });

  test('403 — a plain user cannot trigger generation', async () => {
    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.user)
      .send({ prompt: 'Summarize this.' });
    expect(res.status).toBe(403);
  });

  test('400 — an empty prompt is rejected', async () => {
    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ prompt: '   ' });
    expect(res.status).toBe(400);
  });

  test('202 — queues generation, and the draft settles to done with the generated text', async () => {
    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ prompt: 'Tell the story of this campaign.' });

    expect(res.status).toBe(202);
    expect(['queued', 'generating', 'done']).toContain(res.body.narrativeStatus);

    const settled = await pollUntilSettled(draft.id);
    expect(settled.narrativeStatus).toBe('done');
    expect(settled.narrativeText).toBe('Canned narrative: the Analyst opened the campaign, then saved it.');
    expect(settled.narrativePrompt).toBe('Tell the story of this campaign.');
    expect(settled.narrativeError).toBeNull();
  });

  test('a generation failure surfaces as an error status, not a silent success', async () => {
    const client = getAIClient();
    client.models.generateContent.mockRejectedValueOnce(new Error('Vertex AI is unavailable'));

    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ prompt: 'Tell the story of this campaign.' });
    expect(res.status).toBe(202);

    const settled = await pollUntilSettled(draft.id);
    expect(settled.narrativeStatus).toBe('error');
    expect(settled.narrativeError).toBe('Vertex AI is unavailable');
    expect(settled.narrativeText).toBeNull();
  });
});
