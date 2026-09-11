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
const { extractPdfText, countPdfPages } = require('./helpers/pdfText');
const { clearDatabase, seedUser, seedProject, HEADERS } = require('./helpers/fixtures');
const { downloadStats, resetDownloadStats, delayDownloads } = require('./helpers/gcsMock');

const { IMAGE_PREFETCH_AHEAD } = storyboardsRouter;

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
  await seedProject('finalize-proj', { name: 'Finalize Project', llmModel: 'gemini-3.5-flash' });
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

    // Frame labels follow curated order, not upload order. Since #125 a frame
    // is labelled by its slide number and the Capture's tabUrl, not `Slide N`.
    const slide1Idx = text.indexOf('1 · /campaigns');
    const slide3Idx = text.indexOf('3 · /campaigns');
    expect(slide1Idx).toBeGreaterThan(-1);
    expect(slide3Idx).toBeGreaterThan(-1);
    expect(slide1Idx).toBeLessThan(slide3Idx);
    expect(text).not.toContain('2 · /campaigns'); // pdf-cap-b's slide, excluded
  });

  // #121. The narrative arrives from Gemini as Markdown, and pdfkit's .text()
  // draws whatever characters it is handed — so the first real Storyboard PDF
  // carried 60 `#` headings and 380 `**` markers as visible text. The unit
  // tests in narrative-markdown.test.js cover the parsing; this one is the
  // claim that matters to a Customer, made against the actual artifact.
  test('renders the narrative\'s Markdown rather than printing its syntax', async () => {
    const getRes = await request(app).get(`/admin/storyboards/${draft.id}`).set(HEADERS.analyst);
    const curated = {
      ...getRes.body,
      narrativeText: [
        '### **Phase 1: Retailer Onboarding**',
        '',
        '* **Operator Action:** Creates `FreshMart`.',
        '',
        '---',
        '',
        'Closing line.',
      ].join('\n'),
    };

    const pdfBuffer = await storyboardsRouter.buildStoryboardPdf(curated);
    const text = extractPdfText(pdfBuffer);

    // Every word survives.
    expect(text).toContain('Phase 1: Retailer Onboarding');
    expect(text).toContain('Operator Action:');
    expect(text).toContain('FreshMart');
    expect(text).toContain('Closing line.');

    // None of the syntax does.
    expect(text).not.toContain('**');
    expect(text).not.toContain('###');
    expect(text).not.toContain('`');
  });
});

/**
 * The Storyboard grid (#125, ADR 0019)
 *
 * Six frames to a page, each carrying its own caption, grouped under a header
 * derived from the Capture's `stage`. The layout this replaced put one Capture
 * on a page and no prose on any of them, which made the real 66-Capture draft
 * 73 pages of which 66 were a heading and a screenshot.
 *
 * Asserted against the generated artifact via `helpers/pdfText`, the way #121
 * was — every defect this feature has had was found by opening the PDF and
 * none by a green suite. The drafts here are built by hand rather than through
 * the routes because what is under test is the layout, and a hand-built draft
 * is the only way to put a *missing* caption in front of it: #124 will not let
 * a generation finish without one per slide.
 */
describe('buildStoryboardPdf — the grid', () => {
  const PERSONAS = {
    'grid-1': 'super-admin', 'grid-2': 'super-admin', 'grid-3': 'super-admin',
    'grid-4': 'super-admin', 'grid-5': 'super-admin', 'grid-6': 'super-admin',
    'grid-7': 'super-admin',
    'grid-8': 'media-buyer', 'grid-9': 'media-buyer',
    'grid-10': '',
  };
  const ALL = Object.keys(PERSONAS);

  beforeAll(async () => {
    for (const id of ALL) {
      await seedUpload(id, 'finalize-proj', {
        stage: PERSONAS[id],
        tabUrl: `https://app.example/admin/${id}`,
        uploadedAt: '2026-09-01T09:00:00.000Z',
      });
    }
  });

  afterAll(async () => {
    for (const id of ALL) {
      await db.collection(collections.UPLOADS).doc(id).delete();
    }
  });

  /** A draft `buildStoryboardPdf` can read, without going through the routes. */
  function draftOf(ids, { captions = true, notes = {} } = {}) {
    return {
      id: 'grid-draft',
      projectId: 'finalize-proj',
      status: 'draft',
      narrativeStatus: 'done',
      narrativeText: 'The synthesis.',
      narrativeCaptions: captions
        ? ids.map((id) => ({ captureId: id, caption: `What ${id} shows.` }))
        : null,
      captures: ids.map((id, i) => ({
        captureId: id, order: i + 1, included: true, note: notes[id] ?? null,
      })),
    };
  }

  const build = (draft) => storyboardsRouter.buildStoryboardPdf(draft);

  /** Pages the slides occupy: the total, less whatever the synthesis takes. */
  async function gridPages(ids, opts) {
    const [withSlides, synthesisOnly] = await Promise.all([
      build(draftOf(ids, opts)),
      build(draftOf([])),
    ]);
    return countPdfPages(withSlides) - countPdfPages(synthesisOnly);
  }

  test('a slide carries its own prose — the caption #124 generated for it', async () => {
    const ids = ALL.slice(0, 6);
    const text = extractPdfText(await build(draftOf(ids)));

    for (const id of ids) {
      expect(text).toContain(`What ${id} shows.`);
    }
    // The synthesis keeps its own pages, in front of the slides (ADR 0019).
    expect(text.indexOf('The synthesis.')).toBeLessThan(text.indexOf('What grid-1 shows.'));
  });

  test('six frames to a page — the seventh starts a second one', async () => {
    expect(await gridPages(ALL.slice(0, 6))).toBe(1);
    expect(await gridPages(ALL.slice(0, 7))).toBe(2);
  });

  test('a frame is labelled by slide number and tabUrl, not "Slide N"', async () => {
    const text = extractPdfText(await build(draftOf(ALL.slice(0, 2))));

    expect(text).toContain('1 · /admin/grid-1');
    expect(text).toContain('2 · /admin/grid-2');
    expect(text).not.toContain('Slide 1');
  });

  test('a section header on each Persona change, derived from the Capture stage', async () => {
    // Seven Super Admin frames (a page and a continuation), then two Media
    // Buyer ones: the change starts its own page rather than landing mid-grid.
    const ids = ALL.slice(0, 9);
    const text = extractPdfText(await build(draftOf(ids)));

    expect(text).toContain('Super Admin');
    expect(text).toContain('Super Admin (continued)');
    expect(text).toContain('Media Buyer');
    expect(text.indexOf('Super Admin')).toBeLessThan(text.indexOf('Media Buyer'));
    expect(await gridPages(ids)).toBe(3);
  });

  test('an absent Persona is stored as the empty string, and gets a named section anyway', async () => {
    const text = extractPdfText(await build(draftOf(['grid-10'])));
    expect(text).toContain('Unassigned Persona');
  });

  test('a Capture with no note draws nothing; one with a note draws it', async () => {
    const plain = extractPdfText(await build(draftOf(ALL.slice(0, 3))));
    expect(plain).not.toContain('Note:');

    const annotated = extractPdfText(await build(
      draftOf(ALL.slice(0, 3), { notes: { 'grid-2': 'the tiles are missing' } })
    ));
    expect(annotated).toContain('Note: the tiles are missing');
  });

  // ADR 0019 makes density a constraint on the prose — six frames to a page
  // gives each caption a length budget, and #124 set it at
  // STORYBOARD_CAPTION_MAX_WORDS. A caption at exactly that budget has to fit
  // in the band this layout gives it, or the budget and the layout disagree
  // and the client deliverable is where anyone finds out.
  test('a caption at #124\'s full word budget is drawn whole, not ellipsised', async () => {
    const { STORYBOARD_CAPTION_MAX_WORDS } = require('../src/lib/models');
    const sentence = [
      'The Screens and Users tiles are missing from the administrator dashboard,',
      'which is the first sign that this session is not being treated as a',
      'superadmin; everything below the fold renders correctly, so the gate is on',
      'the tile list itself rather than on the whole page, leaving the operator',
      'entirely unwarned about any of it.',
    ].join(' ');
    const words = sentence.split(/\s+/);
    expect(words.length).toBeGreaterThanOrEqual(STORYBOARD_CAPTION_MAX_WORDS);
    // The budget's last word is a token that appears nowhere else in the
    // document. Ending on whatever word the sentence happens to reach — "the",
    // as it was first written — makes the survival check pass on a caption
    // that was cut, since the page is full of that word already.
    const caption = [
      ...words.slice(0, STORYBOARD_CAPTION_MAX_WORDS - 1),
      'zzlastword',
    ].join(' ');

    const draft = draftOf(['grid-1']);
    draft.narrativeCaptions = [{ captureId: 'grid-1', caption }];
    const text = extractPdfText(await build(draft));

    // The last word survives — pdfkit drops the tail when it ellipsises.
    expect(text).toContain('zzlastword');
    // 0x85 is WinAnsi's ellipsis, which is what an overflowing band would draw.
    expect(text).not.toContain(String.fromCharCode(0x85));
  });

  test('a Capture with no caption says so rather than leaving the frame wordless', async () => {
    const text = extractPdfText(await build(draftOf(ALL.slice(0, 2), { captions: false })));
    expect(text).toContain('(no caption)');
    // The frame is still drawn, labelled, and in order.
    expect(text).toContain('1 · /admin/grid-1');
    expect(text).toContain('2 · /admin/grid-2');
  });

  // #122. Every other test here asks what the page says; this one asks what it
  // cost to get there, because the two are indistinguishable in the artifact.
  // Assembly downloaded each Capture inside the page loop — 66 sequential
  // round trips for the real Storyboard, 89.7s from a developer machine — and
  // no test could tell that from the same PDF assembled in a tenth of the
  // time.
  describe('fetching the frames', () => {
    beforeEach(() => { resetDownloadStats(); });
    afterEach(() => { resetDownloadStats(); });

    test('the downloads overlap, up to the prefetch bound', async () => {
      // More frames than the bound, so the pool is what limits them.
      expect(ALL.length).toBeGreaterThan(IMAGE_PREFETCH_AHEAD);
      await build(draftOf(ALL));

      const { started, maxInFlight } = downloadStats();
      expect(started).toBe(ALL.length);
      expect(maxInFlight).toBe(IMAGE_PREFETCH_AHEAD);
    });

    // The bound is the half that is easy to lose. Unbounded is a one-line
    // change from here, and on the real draft it means 66 simultaneous
    // connections and all 66 images resident in a 512Mi container beside an
    // uncompressed PDF buffer.
    test('and never more than that at once', async () => {
      // Held open, so the count is of downloads genuinely running together
      // rather than of calls issued in one synchronous burst.
      delayDownloads(4);
      await build(draftOf(ALL));

      expect(downloadStats().maxInFlight).toBeLessThanOrEqual(IMAGE_PREFETCH_AHEAD);
    });

    test('a Capture whose bytes never landed is not fetched, and does not stop the rest', async () => {
      // An Abandoned Upload: the row exists, the object does not, so there is
      // no gcsPath to download. It draws a labelled frame with no image.
      await seedUpload('grid-abandoned', 'finalize-proj', {
        stage: 'super-admin', tabUrl: 'https://app.example/admin/gone',
        path: null, gcsPath: null,
      });
      try {
        const text = extractPdfText(await build(draftOf(['grid-1', 'grid-abandoned', 'grid-2'])));

        expect(downloadStats().started).toBe(2);
        expect(text).toContain('2 · /admin/gone');
        expect(text).toContain('3 · /admin/grid-2');
      } finally {
        await db.collection(collections.UPLOADS).doc('grid-abandoned').delete();
      }
    });
  });
});

describe('POST /admin/storyboards/:id/finalize', () => {
  let draft;

  beforeEach(async () => {
    await seedUpload('fin-cap-a', 'finalize-proj', { uploadedAt: '2026-09-01T09:00:00.000Z' });
    draft = await createDraft('finalize-proj');
  });

  afterEach(async () => {
    resetDownloadStats();
    await db.collection(collections.UPLOADS).doc('fin-cap-a').delete();
    await db.collection(collections.STORYBOARD_DRAFTS).doc(draft.id).delete();
  });

  /**
   * The `reports` row this draft's finalize is writing into, once it exists.
   *
   * Polled rather than awaited because the point is to catch the row *during*
   * the request. 40 × 25ms is the same budget `pollUntilSettled` above uses,
   * and is comfortably inside the window `delayDownloads` holds open.
   */
  async function pollForReportRow(draftId, tries = 40) {
    for (let i = 0; i < tries; i += 1) {
      const snap = await db.collection(collections.REPORTS)
        .where('storyboardDraftId', '==', draftId).get();
      if (!snap.empty) return snap.docs[0].data();
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    throw new Error(`no reports row for draft ${draftId}`);
  }

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

    // #103, ADR 0014 — the second of `reports`' three writers, asserted here
    // rather than in a test of its own so the PDF assembly runs once. The
    // Workspace is taken from the draft, which loadOwnedDraft has already proved
    // is the caller's and which has carried the field since #88, so it costs no
    // extra read. Compared against the Project's own stored Workspace rather
    // than a literal, so the fixture default cannot make it pass by coincidence.
    const projectSnap = await db.collection(collections.PROJECTS).doc('finalize-proj').get();
    expect(projectSnap.data().workspaceId).toBeTruthy();
    expect(reportSnap.data().workspaceId).toBe(projectSnap.data().workspaceId);
  });

  // #122. Cloud Run kills a request that outruns `--timeout 300s` without
  // running anything's `catch`, so whatever the row said when assembly began
  // is what the Analyst is left looking at in the Reports tab. It has said
  // `processing` since #89 — untested until now, and a one-line move into the
  // `try` away from saying nothing at all, which is the failure #122 was
  // filed describing.
  test('the `reports` row is written, marked processing, before assembly starts', async () => {
    await generateNarrativeFor(draft.id);
    // The double answers instantly, so without a delay the whole finalize is
    // over before the row can be read: this holds assembly open long enough
    // for "before" to be observable at all.
    delayDownloads(300);

    // `.then()` is what dispatches a supertest request — without it the POST
    // would not have been sent by the time we poll.
    const finalizing = request(app)
      .post(`/admin/storyboards/${draft.id}/finalize`)
      .set(HEADERS.analyst)
      .then((res) => res);

    const inFlight = await pollForReportRow(draft.id);
    expect(inFlight.status).toBe('processing');
    expect(inFlight.reportType).toBe('storyboard');
    expect(inFlight.gcsPath).toBeNull();
    // #127: and it says when to stop believing that `processing`, since the
    // request doing the assembling is what Cloud Run would kill.
    expect(Date.parse(inFlight.mustFinishBy)).toBeGreaterThan(Date.now());

    const res = await finalizing;
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('done');
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
