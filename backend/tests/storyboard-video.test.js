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

// Audio with a real duration, which is the whole of what #128 could not see:
// the double used to answer eight zero bytes, so the synthesized narration had
// no length, and no test could observe it disagreeing with the timeline laid
// under it. 8kHz is a real PCM rate and keeps the fixture small; the rate is
// read from the mimeType below, exactly as Vertex's own answer is.
const TTS_SAMPLE_RATE = 8000;
const TTS_AUDIO_SECONDS = 30;
const TTS_AUDIO_BASE64 = Buffer.alloc(TTS_SAMPLE_RATE * 2 * TTS_AUDIO_SECONDS).toString('base64');
const TTS_RESPONSE = {
  candidates: [{
    content: {
      parts: [{ inlineData: { mimeType: `audio/L16;rate=${TTS_SAMPLE_RATE}`, data: TTS_AUDIO_BASE64 } }]
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
  // Checked here so a refused create says so where it happened. Unchecked,
  // this returned an error body, and the `undefined` id inside it failed some
  // later test that had done nothing wrong — see lessons_learned 85. Either
  // code is a success: the route is find-or-create, 201 for a new draft and
  // 200 for resuming the Project's open one (#85).
  expect([200, 201]).toContain(res.status);
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
  await seedProject('video-proj', { name: 'Video Project', llmModel: 'gemini-3.5-flash' });
  await seedProject('video-order-proj', { name: 'Video Order Project', llmModel: 'gemini-3.5-flash' });
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

    // #128, and the assertion that ticket says could not exist: the double
    // now answers audio of a real length, so the pictures can be checked
    // against it. Shotstack renders the timeline, so a timeline shorter than
    // its soundtrack is narration paid for and thrown away — 46% of it, on
    // the real draft, when every slide got a fixed four seconds.
    const clips = postedTimeline.timeline.tracks[0].clips;
    const timelineSeconds = clips.reduce((n, c) => n + c.length, 0);
    expect(timelineSeconds).toBeCloseTo(TTS_AUDIO_SECONDS, 1);
    expect(timelineSeconds).not.toBeCloseTo(clips.length * 4, 1);
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

  // #128. Given what the narration actually measured, each picture holds the
  // screen for as long as the words about it — not the four seconds every
  // slide used to get, which left 46% of the real draft's narration unplayed.
  test('a slide lasts as long as its own share of the narration', () => {
    const timeline = storyboardsRouter.buildShotstackTimeline(
      ['https://example.com/a.png', 'https://example.com/b.png'],
      'https://example.com/narration.wav',
      { leadInSeconds: 5, slideSeconds: [9, 6] }
    );

    const clips = timeline.timeline.tracks[0].clips;
    // The synthesis is about the whole run, so it plays over the first slide
    // before that slide's own words start: 5 + 9, then 6.
    expect(clips[0]).toMatchObject({ start: 0, length: 14 });
    expect(clips[1]).toMatchObject({ start: 14, length: 6 });

    // And the pictures last exactly as long as the audio under them, which is
    // the property Shotstack cuts the soundtrack for want of.
    expect(clips[clips.length - 1].start + clips[clips.length - 1].length).toBe(5 + 9 + 6);
  });

  test('falls back to fixed-length slides when the audio could not be measured', () => {
    // wavDurationSeconds answers null for anything it does not recognise, and
    // apportionNarration passes that through. Better a timeline that is wrong
    // the old way than one of length nothing.
    const timeline = storyboardsRouter.buildShotstackTimeline(
      ['https://example.com/a.png', 'https://example.com/b.png'],
      'https://example.com/narration.wav',
      null
    );

    const lengths = timeline.timeline.tracks[0].clips.map((c) => c.length);
    expect(lengths).toEqual([
      storyboardsRouter.VIDEO_SLIDE_SECONDS,
      storyboardsRouter.VIDEO_SLIDE_SECONDS,
    ]);
  });

  test('timing that does not cover every slide is not used at all', () => {
    // Falling back slide by slide would mix apportioned lengths with the fixed
    // four seconds in one timeline — a video that paces the first half and not
    // the second reads as a rendering bug, not as a missing measurement.
    const urls = ['a', 'b', 'c'].map((n) => `https://example.com/${n}.png`);

    for (const timing of [
      { leadInSeconds: 5, slideSeconds: [9, 6] },          // one short
      { leadInSeconds: 5, slideSeconds: [9, 6, 0] },       // a slide of nothing
      { leadInSeconds: 5, slideSeconds: [9, 6, NaN] },     // an unmeasurable one
    ]) {
      const clips = storyboardsRouter
        .buildShotstackTimeline(urls, 'https://example.com/narration.wav', timing)
        .timeline.tracks[0].clips;

      expect(clips.map((c) => c.length)).toEqual(
        urls.map(() => storyboardsRouter.VIDEO_SLIDE_SECONDS)
      );
      // And the lead-in goes with it: it describes audio this timeline is no
      // longer laid out against.
      expect(clips[0].start).toBe(0);
    }
  });

  // The rounding the clip lengths get is to two decimals, which Shotstack
  // takes. Rounded to *nearest*, sixty-six of those can land the timeline a
  // hundredth or two under its soundtrack — this ticket's own defect, small
  // enough that no assertion above would notice.
  test('rounding never lands the timeline under the audio, however many slides', () => {
    const slideSeconds = Array.from({ length: 66 }, (_, i) => 7 + (i % 7) / 3);
    const audioSeconds = slideSeconds.reduce((a, b) => a + b, 0) + 5;

    const timeline = storyboardsRouter.buildShotstackTimeline(
      slideSeconds.map((_, i) => `https://example.com/${i}.png`),
      'https://example.com/narration.wav',
      { leadInSeconds: 5, slideSeconds }
    );

    const clips = timeline.timeline.tracks[0].clips;
    const end = clips[clips.length - 1].start + clips[clips.length - 1].length;
    expect(end).toBeGreaterThanOrEqual(audioSeconds);

    // And they still abut exactly, which rounding is the other way to break.
    for (let i = 1; i < clips.length; i++) {
      expect(clips[i].start).toBeCloseTo(clips[i - 1].start + clips[i - 1].length, 6);
    }
  });
});

/**
 * #124 narrowed narrativeText to the synthesis and moved the words about each
 * screen into narrativeCaptions (ADR 0019). The narration has to follow them,
 * or the video silently stops saying anything about the slides it shows.
 */
describe('buildNarrationText', () => {
  const draft = {
    narrativeText: 'The synthesis, spoken first.',
    narrativeCaptions: [
      { captureId: 'cap-b', caption: 'What the second screen shows.' },
      { captureId: 'cap-a', caption: 'What the first screen shows.' },
    ],
    captures: [
      { captureId: 'cap-a', order: 1, included: true },
      { captureId: 'cap-skip', order: 2, included: false },
      { captureId: 'cap-b', order: 3, included: true },
    ],
  };

  test('speaks the synthesis, then each included slide caption in curated order', () => {
    expect(storyboardsRouter.buildNarrationText(draft)).toBe(
      'The synthesis, spoken first.\n\n'
      + 'What the first screen shows.\n\n'
      + 'What the second screen shows.'
    );
  });

  test('says nothing about an excluded Capture', () => {
    const withExcludedCaption = {
      ...draft,
      narrativeCaptions: [...draft.narrativeCaptions, { captureId: 'cap-skip', caption: 'Never spoken.' }],
    };
    expect(storyboardsRouter.buildNarrationText(withExcludedCaption)).not.toMatch(/Never spoken/);
  });

  test('a draft from before #124 narrates its narrativeText exactly as it did', () => {
    const legacy = { narrativeText: 'One block of narrative, as it was.', captures: draft.captures };
    expect(storyboardsRouter.buildNarrationText(legacy)).toBe('One block of narrative, as it was.');
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

    // #103, ADR 0014 — the third and last of `reports`' writers, asserted here
    // rather than in a test of its own so the render flow runs once. The
    // Workspace is taken from the draft, which loadOwnedDraft has already proved
    // is the caller's and which has carried the field since #88. Compared
    // against the Project's own stored Workspace rather than a literal, so the
    // fixture default cannot make it pass by coincidence.
    const projectSnap = await db.collection(collections.PROJECTS).doc('video-proj').get();
    const reportSnap = await db.collection(collections.REPORTS).doc(res.body.id).get();
    expect(projectSnap.data().workspaceId).toBeTruthy();
    expect(reportSnap.data().workspaceId).toBe(projectSnap.data().workspaceId);
    expect(reportSnap.data()).not.toHaveProperty('dateRange'); // #95

    // #127, asserted here for the same reason as the line above — so the
    // render flow runs once. The row was stamped with a deadline while the
    // ~200s of synthesis was happening inside this request; reaching
    // `processing` means the work is Shotstack's now, where a render
    // legitimately takes minutes, so the deadline is cleared and
    // refreshVideoReportStatus owns its liveness from here.
    expect(reportSnap.data().mustFinishBy).toBeNull();
  });

  test('a video row whose request died is settled as error by a later read, not polled for ever', async () => {
    // What a killed request actually leaves: `queued`, with a deadline now in
    // the past and nothing running. Written directly, because the only way to
    // produce it for real is for Cloud Run to kill the request mid-synthesis.
    const abandoned = await db.collection(collections.REPORTS).add({
      projectId: 'video-proj',
      workspaceId: 'video-workspace',
      reportType: 'storyboard-video',
      status: 'queued',
      gcsPath: null,
      storyboardDraftId: draft.id,
      shotstackRenderId: null,
      mustFinishBy: new Date(Date.now() - 60_000).toISOString(),
      requestedBy: 'analyst-fixture-id',
      createdAt: new Date(Date.now() - 400_000).toISOString(),
      updatedAt: new Date(Date.now() - 400_000).toISOString(),
      schemaVersion: 1,
    });

    try {
      const statusRes = await request(app)
        .get(`/admin/reports/${abandoned.id}/status`)
        .set(HEADERS.analyst);
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.status).toBe('error');

      // Settled in Firestore, not just in the answer — the next reader of
      // this row sees it too, which is the difference between reporting the
      // failure and merely describing it.
      const snap = await abandoned.get();
      expect(snap.data().status).toBe('error');
      expect(snap.data().error).toMatch(/did not finish/i);
    } finally {
      await abandoned.delete();
    }
  });

  test('and the artifact route says so too, rather than "still queued" for ever', async () => {
    // The viewer's own read path. Before #127 it answered
    // "This report is still queued. There is no artifact yet." to every
    // request, for ever, about work that had already died.
    const overdue = await db.collection(collections.REPORTS).add({
      projectId: 'video-proj',
      workspaceId: 'video-workspace',
      reportType: 'storyboard-video',
      status: 'queued',
      gcsPath: null,
      storyboardDraftId: draft.id,
      shotstackRenderId: null,
      mustFinishBy: new Date(Date.now() - 60_000).toISOString(),
      requestedBy: 'analyst-fixture-id',
      createdAt: new Date(Date.now() - 400_000).toISOString(),
      updatedAt: new Date(Date.now() - 400_000).toISOString(),
      schemaVersion: 1,
    });

    try {
      const res = await request(app)
        .get(`/admin/reports/${overdue.id}/artifact`)
        .set(HEADERS.analyst);

      expect(res.status).toBe(409);
      expect(res.body.status).toBe('error');
      expect(res.body.error).toMatch(/did not finish/i);
      expect(res.body.error).not.toMatch(/still queued/i);
    } finally {
      await overdue.delete();
    }
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

    // #127: the deadline was stamped when the row was created, before the
    // synthesis that failed — which is the only moment it can be stamped and
    // still be there if the request never gets to write anything again.
    expect(Date.parse(row.mustFinishBy)).toBeGreaterThan(Date.now());
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
