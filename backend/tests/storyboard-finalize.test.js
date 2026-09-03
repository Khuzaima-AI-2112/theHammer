/**
 * Finalize a Storyboard draft into a PDF (#89)
 *
 * POST /admin/storyboards/:id/finalize assembles a PDF from the draft's
 * curated Captures — in chosen order, each with its note, wrapped in the
 * final narrative — writes it to GCS, and creates a `reports` Firestore doc
 * with `reportType: 'storyboard'` so the Storyboard shows up in the existing
 * Reports list (GET /admin/reports) the same way any other report does.
 * Finalizing requires narrativeStatus === 'done' (#86); it is refused
 * otherwise, edited (#87) or not.
 *
 * Firestore: emulator. Cloud Storage: mocked, with `realPngBytes: true` since
 * pdfkit actually decodes the Capture bytes it embeds — unlike the ZIP
 * export, which only moves bytes around. Vertex AI (`@google/genai`): mocked,
 * used only to get a draft into narrativeStatus 'done' via the existing
 * narrative-generation route (#86), not by this ticket's own code.
 */
'use strict';

const request = require('supertest');

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock({
  signedUrlPrefix: 'https://storage.googleapis.com/fake-bucket/',
  realPngBytes: true,
}));
jest.mock('@google/genai', () => require('./helpers/genaiMock').createGenAIMock({
  text: 'The Analyst opened the campaign, then walked through setup.'
}));

process.env.GCS_BUCKET = 'fake-bucket';

const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const storyboardsRouter = require('../src/routes/admin/storyboards');
const collections = require('../src/lib/collections');
const { extractPdfText } = require('./helpers/pdfText');
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

async function generateNarrativeFor(draftId) {
  await request(app)
    .post(`/admin/storyboards/${draftId}/narrative`)
    .set(HEADERS.analyst)
    .send({ prompt: 'Tell the story of this campaign.' });
  return pollUntilSettled(draftId);
}

beforeAll(async () => {
  await clearDatabase();
  await seedUser('admin-fixture-id', { email: 'admin-fixture@test.com', role: 'admin' });
  await seedUser('analyst-fixture-id', { email: 'analyst-fixture@test.com', role: 'analyst' });
  await seedUser('user-fixture-id', { email: 'user-fixture@test.com', role: 'user' });
  await seedProject('finalize-proj', { name: 'Finalize Project', llmModel: 'gemini-1.5-flash' });
});

afterAll(async () => {
  await clearDatabase();
});

describe('buildStoryboardPdf', () => {
  let draft;

  beforeAll(async () => {
    await seedUpload('pdf-cap-a', 'finalize-proj', { uploadedAt: '2026-09-01T09:00:00.000Z' });
    await seedUpload('pdf-cap-b', 'finalize-proj', { uploadedAt: '2026-09-01T09:05:00.000Z' });
    await seedUpload('pdf-cap-c', 'finalize-proj', { uploadedAt: '2026-09-01T09:10:00.000Z' });
    draft = await createDraft('finalize-proj');

    // Seeded/curated out of order on purpose — project-export.test.js's
    // "order is the point" convention. pdf-cap-b is excluded and must never
    // appear; pdf-cap-c and pdf-cap-a are reordered so upload order and
    // curated order disagree.
    await request(app)
      .patch(`/admin/storyboards/${draft.id}`)
      .set(HEADERS.analyst)
      .send({
        captures: [
          { captureId: 'pdf-cap-c', order: 1, included: true, note: 'note-first' },
          { captureId: 'pdf-cap-b', order: 2, included: false, note: 'note-excluded' },
          { captureId: 'pdf-cap-a', order: 3, included: true, note: 'note-last' },
        ]
      });
  });

  afterAll(async () => {
    for (const id of ['pdf-cap-a', 'pdf-cap-b', 'pdf-cap-c']) {
      await db.collection(collections.UPLOADS).doc(id).delete();
    }
    await db.collection(collections.STORYBOARD_DRAFTS).doc(draft.id).delete();
  });

  test('places curated Captures in chosen order, each with its note, wrapped in the narrative — excluding what was excluded', async () => {
    const getRes = await request(app).get(`/admin/storyboards/${draft.id}`).set(HEADERS.analyst);
    const curated = { ...getRes.body, narrativeText: 'Wrapping narrative text.' };

    const pdfBuffer = await storyboardsRouter.buildStoryboardPdf(curated);
    const text = extractPdfText(pdfBuffer);

    expect(text).toContain('Wrapping narrative text.');
    expect(text).not.toContain('note-excluded');

    const firstIdx = text.indexOf('note-first');
    const lastIdx = text.indexOf('note-last');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(lastIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(lastIdx);

    // Narrative page precedes every slide.
    expect(text.indexOf('Wrapping narrative text.')).toBeLessThan(firstIdx);

    // Slide labels follow curated order, not upload order.
    const slide1Idx = text.indexOf('Slide 1');
    const slide3Idx = text.indexOf('Slide 3');
    expect(slide1Idx).toBeGreaterThan(-1);
    expect(slide3Idx).toBeGreaterThan(-1);
    expect(slide1Idx).toBeLessThan(slide3Idx);
    expect(text).not.toContain('Slide 2'); // pdf-cap-b's slide number, excluded
  });
});

describe('POST /admin/storyboards/:id/finalize', () => {
  let draft;

  beforeEach(async () => {
    await seedUpload('fin-cap-a', 'finalize-proj', { uploadedAt: '2026-09-01T09:00:00.000Z' });
    draft = await createDraft('finalize-proj');
  });

  afterEach(async () => {
    await db.collection(collections.UPLOADS).doc('fin-cap-a').delete();
    await db.collection(collections.STORYBOARD_DRAFTS).doc(draft.id).delete();
  });

  test('404 — no such draft', async () => {
    const res = await request(app)
      .post('/admin/storyboards/no-such-draft/finalize')
      .set(HEADERS.analyst);
    expect(res.status).toBe(404);
  });

  test('403 — draft belongs to another workspace', async () => {
    const foreignRef = db.collection(collections.STORYBOARD_DRAFTS).doc();
    await foreignRef.set({
      projectId: 'finalize-proj',
      workspaceId: 'other-workspace',
      status: 'draft',
      captures: [],
      narrativeStatus: 'done',
      narrativeText: 'Existing text.',
      createdBy: 'someone-else',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    const res = await request(app)
      .post(`/admin/storyboards/${foreignRef.id}/finalize`)
      .set(HEADERS.analyst);
    expect(res.status).toBe(403);
    await foreignRef.delete();
  });

  test('403 — a plain user cannot finalize', async () => {
    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/finalize`)
      .set(HEADERS.user);
    expect(res.status).toBe(403);
  });

  test('400 — a draft with no completed narrative cannot be finalized', async () => {
    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/finalize`)
      .set(HEADERS.analyst);
    expect(res.status).toBe(400);

    const reportsRes = await request(app)
      .get(`/admin/reports?projectId=finalize-proj`)
      .set(HEADERS.analyst);
    expect(reportsRes.body.reports.some((r) => r.storyboardDraftId === draft.id)).toBe(false);
  });

  test('400 — a draft whose generation ended in error still cannot be finalized', async () => {
    const { getAIClient } = require('../src/lib/vertex');
    getAIClient().models.generateContent.mockRejectedValueOnce(new Error('Vertex AI is unavailable'));

    await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ prompt: 'Tell the story.' });
    await pollUntilSettled(draft.id);

    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/finalize`)
      .set(HEADERS.analyst);
    expect(res.status).toBe(400);
  });

  test('201 — creates a `reports` doc with reportType "storyboard" and a gcsPath, once narrative generation has completed', async () => {
    await generateNarrativeFor(draft.id);

    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/finalize`)
      .set(HEADERS.analyst);
    expect(res.status).toBe(201);
    expect(res.body.reportType).toBe('storyboard');
    expect(res.body.status).toBe('done');
    expect(res.body.projectId).toBe('finalize-proj');
    expect(res.body.storyboardDraftId).toBe(draft.id);
    expect(typeof res.body.gcsPath).toBe('string');
    expect(res.body.gcsPath).toMatch(/^finalize-proj\/reports\/.+\.pdf$/);

    // Firestore doc itself carries the same fields.
    const reportSnap = await db.collection(collections.REPORTS).doc(res.body.id).get();
    expect(reportSnap.exists).toBe(true);
    expect(reportSnap.data().reportType).toBe('storyboard');
    expect(reportSnap.data().gcsPath).toBe(res.body.gcsPath);
  });

  test('a finalized Storyboard appears in the existing Reports list, viewable the same way any other report is', async () => {
    await generateNarrativeFor(draft.id);
    const finalizeRes = await request(app)
      .post(`/admin/storyboards/${draft.id}/finalize`)
      .set(HEADERS.analyst);

    const reportsRes = await request(app)
      .get(`/admin/reports?projectId=finalize-proj`)
      .set(HEADERS.analyst);
    expect(reportsRes.status).toBe(200);

    const row = reportsRes.body.reports.find((r) => r.id === finalizeRes.body.id);
    expect(row).toBeDefined();
    expect(row.reportType).toBe('storyboard');
    expect(row.status).toBe('done');
    expect(row.gcsPath).toBe(finalizeRes.body.gcsPath);
  });

  test('an edited narrative (#87) is still finalizable, and the PDF carries the edited text — not the original', async () => {
    await generateNarrativeFor(draft.id);
    await request(app)
      .patch(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ narrativeText: 'A hand-edited correction.' });

    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/finalize`)
      .set(HEADERS.analyst);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('done');

    // buildStoryboardPdf embeds whatever narrativeText the draft carries at
    // finalize time — the route re-fetches the draft fresh (storyboards.js),
    // so this proves the edit, not the original AI text, is what lands in
    // the PDF, not just that finalizing an edited draft isn't blocked.
    const draftAfterEdit = (await request(app)
      .get(`/admin/storyboards/${draft.id}`)
      .set(HEADERS.analyst)).body;
    expect(draftAfterEdit.narrativeText).toBe('A hand-edited correction.');

    const pdfBuffer = await storyboardsRouter.buildStoryboardPdf(draftAfterEdit);
    const text = extractPdfText(pdfBuffer);
    expect(text).toContain('A hand-edited correction.');
    expect(text).not.toContain('The Analyst opened the campaign, then walked through setup.');
  });
});
