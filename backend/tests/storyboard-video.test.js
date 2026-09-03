/**
 * Generate a narrated video from a finalized Storyboard (#90)
 *
 * POST /admin/storyboards/:id/video is a separate, explicit action from
 * finalizing (#89) — it requires a finalized PDF to already exist. The
 * backend synthesizes narration from the finalized narrative text (never
 * #88's raw recording), builds a Shotstack timeline from the curated
 * Captures, and posts it to Shotstack's /render. Status surfaces through the
 * same GET /admin/reports/:id/status poll the PDF already uses, refreshed
 * lazily against Shotstack (lib/shotstack.js) rather than pushed.
 *
 * Firestore: emulator. Cloud Storage: mocked, with `realPngBytes: true` (the
 * PDF assembly this draft is finalized through embeds real images). Vertex
 * AI (`@google/genai`): mocked — one call generates the narrative, a second
 * synthesizes speech. Shotstack: mocked via `global.fetch` — see
 * helpers/shotstackMock.js.
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
process.env.SHOTSTACK_API_KEY = 'fake-shotstack-key';

const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const { getAIClient } = require('../src/lib/vertex');
const storyboardsRouter = require('../src/routes/admin/storyboards');
const collections = require('../src/lib/collections');
const { createShotstackMock } = require('./helpers/shotstackMock');
const { clearDatabase, seedUser, seedProject, HEADERS } = require('./helpers/fixtures');

const TTS_AUDIO_BASE64 = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
const TTS_RESPONSE = {
  candidates: [{
    content: {
      parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: TTS_AUDIO_BASE64 } }]
    }
  }]
};

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

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

async function generateAndFinalize(draftId) {
  await request(app)
    .post(`/admin/storyboards/${draftId}/narrative`)
    .set(HEADERS.analyst)
    .send({ prompt: 'Tell the story of this campaign.' });
  await pollUntilSettled(draftId);

  const finalizeRes = await request(app)
    .post(`/admin/storyboards/${draftId}/finalize`)
    .set(HEADERS.analyst);
  return finalizeRes.body;
}

beforeAll(async () => {
  await clearDatabase();
  await seedUser('admin-fixture-id', { email: 'admin-fixture@test.com', role: 'admin' });
  await seedUser('analyst-fixture-id', { email: 'analyst-fixture@test.com', role: 'analyst' });
  await seedUser('user-fixture-id', { email: 'user-fixture@test.com', role: 'user' });
  await seedProject('video-proj', { name: 'Video Project', llmModel: 'gemini-1.5-flash' });
  await seedProject('video-order-proj', { name: 'Video Order Project', llmModel: 'gemini-1.5-flash' });
});

afterAll(async () => {
  await clearDatabase();
});

describe('lib/shotstack.js fails loudly on missing configuration', () => {
  test('submitRender refuses to call Shotstack with no SHOTSTACK_API_KEY set', async () => {
    const previousKey = process.env.SHOTSTACK_API_KEY;
    delete process.env.SHOTSTACK_API_KEY;

    let shotstack;
    jest.isolateModules(() => {
      shotstack = require('../src/lib/shotstack');
    });

    await expect(shotstack.submitRender({})).rejects.toThrow(/SHOTSTACK_API_KEY not set/);

    process.env.SHOTSTACK_API_KEY = previousKey;
  });
});

describe('POST /admin/storyboards/:id/video — curated order end-to-end', () => {
  // A dedicated Project, never touched by the other describe blocks' shared
  // 'video-proj' — that project already carries an open draft mid-test in
  // several cases, and POST /projects/:id/storyboards is find-or-create
  // (#85): reusing 'video-proj' here would resume that draft instead of
  // creating the one this test curates.
  test('the Shotstack timeline reflects curated order, excluding excluded Captures', async () => {
    await seedUpload('order-cap-a', 'video-order-proj', { uploadedAt: '2026-09-01T09:00:00.000Z' });
    await seedUpload('order-cap-b', 'video-order-proj', { uploadedAt: '2026-09-01T09:05:00.000Z' });
    await seedUpload('order-cap-c', 'video-order-proj', { uploadedAt: '2026-09-01T09:10:00.000Z' });
    const orderedDraft = await createDraft('video-order-proj');

    // Seeded/curated out of order on purpose — project-export.test.js's
    // "order is the point" convention. order-cap-a is excluded and must
    // never appear; order-cap-c and order-cap-b are reordered so upload
    // order and curated order disagree.
    const patchRes = await request(app)
      .patch(`/admin/storyboards/${orderedDraft.id}`)
      .set(HEADERS.analyst)
      .send({
        captures: [
          { captureId: 'order-cap-c', order: 1, included: true, note: '' },
          { captureId: 'order-cap-a', order: 2, included: false, note: '' },
          { captureId: 'order-cap-b', order: 3, included: true, note: '' },
        ]
      });
    expect(patchRes.status).toBe(200);

    await generateAndFinalize(orderedDraft.id);

    global.fetch = createShotstackMock({ status: 'done' });
    const client = getAIClient();
    client.models.generateContent.mockResolvedValueOnce(TTS_RESPONSE);

    const res = await request(app)
      .post(`/admin/storyboards/${orderedDraft.id}/video`)
      .set(HEADERS.analyst);
    expect(res.status).toBe(201);

    const renderCall = global.fetch.mock.calls.find(([url]) => String(url).endsWith('/render'));
    expect(renderCall).toBeDefined();
    const postedTimeline = JSON.parse(renderCall[1].body);
    const clipSrcs = postedTimeline.timeline.tracks[0].clips.map((c) => c.asset.src);

    expect(clipSrcs).toHaveLength(2); // order-cap-a excluded
    expect(clipSrcs[0]).toContain('order-cap-c.png');
    expect(clipSrcs[1]).toContain('order-cap-b.png');
    expect(clipSrcs.join(' ')).not.toContain('order-cap-a.png');
  });
});

describe('buildShotstackTimeline', () => {
  test('lays out image clips end to end, in the given order, with the narration as the soundtrack', () => {
    const timeline = storyboardsRouter.buildShotstackTimeline(
      ['https://example.com/first.png', 'https://example.com/second.png', 'https://example.com/third.png'],
      'https://example.com/narration.wav'
    );

    expect(timeline.timeline.soundtrack.src).toBe('https://example.com/narration.wav');
    const clips = timeline.timeline.tracks[0].clips;
    expect(clips.map((c) => c.asset.src)).toEqual([
      'https://example.com/first.png',
      'https://example.com/second.png',
      'https://example.com/third.png',
    ]);

    // End to end: each clip starts exactly where the previous one ended.
    for (let i = 1; i < clips.length; i++) {
      expect(clips[i].start).toBe(clips[i - 1].start + clips[i - 1].length);
    }
    expect(clips[0].start).toBe(0);
  });
});

describe('POST /admin/storyboards/:id/video', () => {
  let draft;

  beforeEach(async () => {
    await seedUpload('vid-cap-a', 'video-proj', { uploadedAt: '2026-09-01T09:00:00.000Z' });
    draft = await createDraft('video-proj');
    global.fetch = createShotstackMock({ status: 'done' });
  });

  afterEach(async () => {
    await db.collection(collections.UPLOADS).doc('vid-cap-a').delete();
    const snap = await db.collection(collections.STORYBOARD_DRAFTS)
      .where('projectId', '==', 'video-proj').get();
    for (const doc of snap.docs) await doc.ref.delete();
    const reportsSnap = await db.collection(collections.REPORTS)
      .where('projectId', '==', 'video-proj').get();
    for (const doc of reportsSnap.docs) await doc.ref.delete();
  });

  test('404 — no such draft', async () => {
    const res = await request(app)
      .post('/admin/storyboards/no-such-draft/video')
      .set(HEADERS.analyst);
    expect(res.status).toBe(404);
  });

  test('403 — a plain user cannot generate a video', async () => {
    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/video`)
      .set(HEADERS.user);
    expect(res.status).toBe(403);
  });

  test('400 — refused when the Storyboard has no completed narrative at all', async () => {
    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/video`)
      .set(HEADERS.analyst);
    expect(res.status).toBe(400);
  });

  test('400 — refused when a narrative exists but the Storyboard has never been finalized into a PDF', async () => {
    await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ prompt: 'Tell the story.' });
    await pollUntilSettled(draft.id);

    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/video`)
      .set(HEADERS.analyst);
    expect(res.status).toBe(400);
  });

  test('201 — synthesizes narration and starts a Shotstack render, once finalized', async () => {
    await generateAndFinalize(draft.id);

    const client = getAIClient();
    client.models.generateContent.mockResolvedValueOnce(TTS_RESPONSE);

    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/video`)
      .set(HEADERS.analyst);
    expect(res.status).toBe(201);
    expect(res.body.reportType).toBe('storyboard-video');
    expect(res.body.status).toBe('processing');
    expect(res.body.shotstackRenderId).toBe('mock-render-id');
    expect(res.body.storyboardDraftId).toBe(draft.id);
  });

  test('a generation failure (e.g. text-to-speech) surfaces as an explicit error status', async () => {
    await generateAndFinalize(draft.id);

    const client = getAIClient();
    client.models.generateContent.mockRejectedValueOnce(new Error('Vertex AI TTS is unavailable'));

    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/video`)
      .set(HEADERS.analyst);
    expect(res.status).toBe(500);

    const reportsRes = await request(app)
      .get(`/admin/reports?projectId=video-proj`)
      .set(HEADERS.analyst);
    const row = reportsRes.body.reports.find((r) => r.reportType === 'storyboard-video');
    expect(row.status).toBe('error');
    expect(row.error).toMatch(/Vertex AI TTS is unavailable/);
  });
});

describe('video status polling (GET /admin/reports/:id/status and GET /admin/reports)', () => {
  let draft;

  beforeEach(async () => {
    await seedUpload('poll-cap-a', 'video-proj', { uploadedAt: '2026-09-01T09:00:00.000Z' });
    draft = await createDraft('video-proj');
  });

  afterEach(async () => {
    await db.collection(collections.UPLOADS).doc('poll-cap-a').delete();
    const snap = await db.collection(collections.STORYBOARD_DRAFTS)
      .where('projectId', '==', 'video-proj').get();
    for (const doc of snap.docs) await doc.ref.delete();
    const reportsSnap = await db.collection(collections.REPORTS)
      .where('projectId', '==', 'video-proj').get();
    for (const doc of reportsSnap.docs) await doc.ref.delete();
  });

  async function startVideo() {
    await generateAndFinalize(draft.id);
    const client = getAIClient();
    client.models.generateContent.mockResolvedValueOnce(TTS_RESPONSE);
    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/video`)
      .set(HEADERS.analyst);
    return res.body;
  }

  test('the mocked render still rendering leaves the report "processing"', async () => {
    global.fetch = createShotstackMock({ status: 'rendering' });
    const video = await startVideo();

    const statusRes = await request(app).get(`/admin/reports/${video.id}/status`).set(HEADERS.analyst);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('processing');
    expect(statusRes.body.gcsPath).toBeNull();
  });

  test('the mocked render finishing is persisted as "done" with a gcsPath, and downloadable from the Reports list', async () => {
    global.fetch = createShotstackMock({ status: 'rendering' });
    const video = await startVideo();

    global.fetch = createShotstackMock({ status: 'done', videoUrl: 'https://shotstack-cdn.example/finished.mp4' });
    const statusRes = await request(app).get(`/admin/reports/${video.id}/status`).set(HEADERS.analyst);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('done');
    expect(statusRes.body.gcsPath).toMatch(/^video-proj\/reports\/.+\.mp4$/);

    // Persisted, not just returned once — a fresh read agrees.
    const reportSnap = await db.collection(collections.REPORTS).doc(video.id).get();
    expect(reportSnap.data().status).toBe('done');
    expect(reportSnap.data().gcsPath).toBe(statusRes.body.gcsPath);

    // Viewable from the Reports list alongside the PDF, the same way any
    // other report is (GET /admin/reports, unmodified for viewing itself).
    const reportsRes = await request(app).get(`/admin/reports?projectId=video-proj`).set(HEADERS.analyst);
    const row = reportsRes.body.reports.find((r) => r.id === video.id);
    expect(row.status).toBe('done');
    expect(row.gcsPath).toBe(statusRes.body.gcsPath);
  });

  test('the mocked render failing is persisted as "error"', async () => {
    global.fetch = createShotstackMock({ status: 'rendering' });
    const video = await startVideo();

    global.fetch = createShotstackMock({ status: 'failed', errorMessage: 'encoding failed' });
    const statusRes = await request(app).get(`/admin/reports/${video.id}/status`).set(HEADERS.analyst);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('error');

    const reportSnap = await db.collection(collections.REPORTS).doc(video.id).get();
    expect(reportSnap.data().status).toBe('error');
    expect(reportSnap.data().error).toBe('encoding failed');
  });

  test('GET /admin/reports refreshes a "processing" video row too, not only the individual status route', async () => {
    global.fetch = createShotstackMock({ status: 'rendering' });
    const video = await startVideo();

    global.fetch = createShotstackMock({ status: 'done', videoUrl: 'https://shotstack-cdn.example/list-refresh.mp4' });
    const reportsRes = await request(app).get(`/admin/reports?projectId=video-proj`).set(HEADERS.analyst);
    const row = reportsRes.body.reports.find((r) => r.id === video.id);
    expect(row.status).toBe('done');
    expect(row.gcsPath).toMatch(/^video-proj\/reports\/.+\.mp4$/);
  });
});
