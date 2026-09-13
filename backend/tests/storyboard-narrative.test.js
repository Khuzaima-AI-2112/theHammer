/**
 * AI narrative generation from a Storyboard draft (#86, #124)
 *
 * POST /admin/storyboards/:id/narrative takes a typed prompt, builds a
 * multimodal Gemini request from the draft's *included*, *ordered* Captures
 * (as gs:// image references) plus their notes, and writes the result back
 * onto the draft as narrativeStatus/narrativeText — not into the `reports`
 * collection (see storyboards.js's header comment and ADR 0013).
 *
 * Since #124 the model returns a structured `{ synthesis, captions }` rather
 * than one block of prose (ADR 0019). The shared double answers the slide
 * numbers it was sent (see helpers/genaiMock.js); `text` below is the
 * synthesis half. A test that needs a specific — or malformed — response
 * mocks that one call directly.
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

const CANNED_SYNTHESIS = 'Canned narrative: the Analyst opened the campaign, then saved it.';
const CANNED_CAPTION = 'Canned caption for slide 1.';

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
  await seedProject('narrative-proj', { name: 'Narrative Project', llmModel: 'gemini-3.5-flash' });
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

    // The Analyst's own words come first, ahead of the product's formatting
    // instruction — ADR 0016's clearance turns on which of the two is steering.
    expect(parts[0]).toEqual({ text: 'Tell the story of this campaign.' });
    expect(parts[1].text).toMatch(/caption/i);

    // narr-cap-c (order 1, included) — slide marker, image, then its note
    expect(parts[2]).toEqual({ text: 'Slide 1:' });
    expect(parts[3]).toEqual({ fileData: { mimeType: 'image/png', fileUri: 'gs://fake-bucket/narrative-proj/narr-cap-c.png' } });
    expect(parts[4]).toEqual({ text: 'Slide 1 note: opening screen' });

    // narr-cap-b (excluded) never appears anywhere in the parts
    expect(parts.some((p) => p.fileData?.fileUri.includes('narr-cap-b'))).toBe(false);
    expect(parts.some((p) => p.text?.includes('skip this one'))).toBe(false);

    // narr-cap-a (order 3, included, no note) — marker and image, no stray note part
    expect(parts[5]).toEqual({ text: 'Slide 3:' });
    expect(parts[6]).toEqual({ fileData: { mimeType: 'image/png', fileUri: 'gs://fake-bucket/narrative-proj/narr-cap-a.png' } });
    expect(parts).toHaveLength(7);
  });

  test('every included slide is numbered in the request, since a caption is keyed by that number', async () => {
    const getRes = await request(app).get(`/admin/storyboards/${draft.id}`).set(HEADERS.analyst);

    const req = await storyboardsRouter.buildNarrativeRequest(getRes.body, 'Tell the story.');
    const markers = req.contents[0].parts
      .map((p) => p.text)
      .filter((t) => /^Slide \d+:$/.test(t ?? ''));

    // Curated order values, not 1..n — slide 2 is excluded, and a caption for
    // it would be a caption for a Capture that is not in the Storyboard.
    expect(markers).toEqual(['Slide 1:', 'Slide 3:']);
  });

  // #126, ADR 0020. The model is told which Workflow each slide sits in, as
  // context; it is not asked to decide one.
  test('each slide under a Workflow divider carries that Workflow\'s name', async () => {
    const getRes = await request(app).get(`/admin/storyboards/${draft.id}`).set(HEADERS.analyst);
    const curated = {
      ...getRes.body,
      // Position 1 sits between slide 1 and the excluded slide 2, so slide 1 is
      // untitled and slide 3 is "Brand".
      workflows: [{ id: 'wf-brand', name: 'Brand', position: 1 }],
    };

    const req = await storyboardsRouter.buildNarrativeRequest(curated, 'Tell the story.');
    const texts = req.contents[0].parts.map((p) => p.text).filter(Boolean);

    expect(texts).toContain('Slide 3 workflow: Brand');
    expect(texts.some((t) => /^Slide 1 workflow:/.test(t))).toBe(false);
    // Stated before the image it describes, next to the slide marker.
    expect(texts.indexOf('Slide 3 workflow: Brand')).toBe(texts.indexOf('Slide 3:') + 1);
  });

  test('asks for JSON against a schema, with an output budget that scales with the slide count', async () => {
    const getRes = await request(app).get(`/admin/storyboards/${draft.id}`).set(HEADERS.analyst);

    const req = await storyboardsRouter.buildNarrativeRequest(getRes.body, 'Tell the story.');

    expect(req.config.responseMimeType).toBe('application/json');
    expect(req.config.responseSchema.properties.captions).toBeDefined();
    expect(req.config.responseSchema.required).toEqual(expect.arrayContaining(['synthesis', 'captions']));

    // #124: the request used to send no generationConfig at all, on a thinking
    // model whose reasoning tokens count against the budget (lib/models.js).
    const { storyboardMaxOutputTokens } = require('../src/lib/models');
    expect(req.config.maxOutputTokens).toBe(storyboardMaxOutputTokens(2));
    expect(storyboardMaxOutputTokens(66)).toBeGreaterThan(storyboardMaxOutputTokens(2));
  });
});

/**
 * The half of #124 that can fail without a network: what comes back is JSON
 * the model wrote, and every one of these cases ends as a slide that reaches a
 * client with nothing written on it if it is not caught here.
 */
describe('parseNarrativeResponse', () => {
  const included = [
    { captureId: 'cap-first', order: 1 },
    { captureId: 'cap-third', order: 3 },
  ];

  const valid = JSON.stringify({
    synthesis: 'Two screens, one story.',
    captions: [
      { slide: 3, caption: 'The second one.' },
      { slide: 1, caption: 'The first one.' },
    ],
  });

  test('maps each caption onto its Capture id, in curated order', () => {
    const parsed = storyboardsRouter.parseNarrativeResponse(valid, included);

    expect(parsed.synthesis).toBe('Two screens, one story.');
    // Keyed by captureId, not slide number: a later reorder moves the slide
    // number and must not move the caption onto a different screenshot.
    expect(parsed.captions).toEqual([
      { captureId: 'cap-first', caption: 'The first one.' },
      { captureId: 'cap-third', caption: 'The second one.' },
    ]);
  });

  test('rejects a caption for a slide that is not in the Storyboard', () => {
    const body = JSON.stringify({
      synthesis: 'ok',
      captions: [
        { slide: 1, caption: 'a' },
        { slide: 2, caption: 'a caption for an excluded Capture' },
        { slide: 3, caption: 'c' },
      ],
    });
    expect(() => storyboardsRouter.parseNarrativeResponse(body, included)).toThrow(/slide 2/i);
  });

  test('rejects a missing caption rather than finalizing a slide with nothing on it', () => {
    const body = JSON.stringify({ synthesis: 'ok', captions: [{ slide: 1, caption: 'a' }] });
    expect(() => storyboardsRouter.parseNarrativeResponse(body, included)).toThrow(/slide 3/i);
  });

  test('rejects two captions for the same slide', () => {
    const body = JSON.stringify({
      synthesis: 'ok',
      captions: [
        { slide: 1, caption: 'a' },
        { slide: 1, caption: 'also a' },
        { slide: 3, caption: 'c' },
      ],
    });
    expect(() => storyboardsRouter.parseNarrativeResponse(body, included)).toThrow(/duplicate/i);
  });

  test('rejects text that is not JSON at all', () => {
    expect(() => storyboardsRouter.parseNarrativeResponse('I am afraid I cannot do that.', included))
      .toThrow(/json/i);
  });

  test('rejects an empty response — the shape of a budget spent entirely on thinking', () => {
    expect(() => storyboardsRouter.parseNarrativeResponse('', included)).toThrow(/no text/i);
  });

  test('rejects a missing or blank synthesis', () => {
    const body = JSON.stringify({ synthesis: '   ', captions: [{ slide: 1, caption: 'a' }, { slide: 3, caption: 'c' }] });
    expect(() => storyboardsRouter.parseNarrativeResponse(body, included)).toThrow(/synthesis/i);
  });

  test('rejects a blank caption, which is the same empty slide by another route', () => {
    const body = JSON.stringify({ synthesis: 'ok', captions: [{ slide: 1, caption: '' }, { slide: 3, caption: 'c' }] });
    expect(() => storyboardsRouter.parseNarrativeResponse(body, included)).toThrow(/slide 1/i);
  });

  test('a Storyboard with no included Captures needs no captions', () => {
    const body = JSON.stringify({ synthesis: 'Nothing was curated in.', captions: [] });
    expect(storyboardsRouter.parseNarrativeResponse(body, [])).toEqual({
      synthesis: 'Nothing was curated in.',
      captions: [],
    });
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
    // narrativeText is the synthesis — the same field, still the free-form
    // half, still Markdown (ADR 0018). The captions are new state beside it.
    expect(settled.narrativeText).toBe(CANNED_SYNTHESIS);
    expect(settled.narrativeCaptions).toEqual([
      { captureId: 'gen-cap-a', caption: CANNED_CAPTION },
    ]);
    expect(settled.narrativePrompt).toBe('Tell the story of this campaign.');
    expect(settled.narrativeError).toBeNull();
  });

  test('a caption for a Capture that is not in the Storyboard fails the run, rather than being dropped', async () => {
    const client = getAIClient();
    client.models.generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        synthesis: 'A synthesis that looks perfectly fine.',
        captions: [{ slide: 1, caption: 'ok' }, { slide: 9, caption: 'a slide that does not exist' }],
      })
    });

    await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ prompt: 'Tell the story of this campaign.' });

    const settled = await pollUntilSettled(draft.id);
    expect(settled.narrativeStatus).toBe('error');
    expect(settled.narrativeError).toMatch(/slide 9/i);
    expect(settled.narrativeText).toBeNull();
    expect(settled.narrativeCaptions).toBeNull();
  });

  test('a missing caption fails the run — never a done status with a slide left blank', async () => {
    const client = getAIClient();
    client.models.generateContent.mockResolvedValueOnce({
      text: JSON.stringify({ synthesis: 'A synthesis and no captions at all.', captions: [] })
    });

    await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ prompt: 'Tell the story of this campaign.' });

    const settled = await pollUntilSettled(draft.id);
    expect(settled.narrativeStatus).toBe('error');
    expect(settled.narrativeError).toMatch(/slide 1/i);
    expect(settled.narrativeText).toBeNull();
  });

  test('the model\'s answer cannot touch the Workflow dividers, whatever it sends back', async () => {
    const dividers = [{ id: 'wf-1', name: 'Super Admin', position: 0 }];
    await request(app)
      .patch(`/admin/storyboards/${draft.id}`)
      .set(HEADERS.analyst)
      .send({ captures: draft.captures.map(({ signedUrl, ...c }) => c), workflows: dividers });

    const client = getAIClient();
    client.models.generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        synthesis: 'A synthesis.',
        captions: [{ slide: 1, caption: 'A caption.' }],
        workflows: [{ id: 'wf-evil', name: 'Renamed by the model', position: 1 }],
      })
    });

    await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ prompt: 'Tell the story of this campaign.' });

    const settled = await pollUntilSettled(draft.id);
    expect(settled.narrativeStatus).toBe('done');
    expect(settled.workflows).toEqual(dividers);
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

  test('regeneration replaces the narrative, including a hand edit made after the first run', async () => {
    await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ prompt: 'First pass.' });
    const first = await pollUntilSettled(draft.id);
    expect(first.narrativeText).toBe(CANNED_SYNTHESIS);

    await request(app)
      .patch(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ narrativeText: 'A hand-edited correction.' });

    const client = getAIClient();
    client.models.generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        synthesis: 'Second pass narrative.',
        captions: [{ slide: 1, caption: 'A second-pass caption.' }],
      })
    });

    await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ prompt: 'Second pass.' });

    const second = await pollUntilSettled(draft.id);
    expect(second.narrativeText).toBe('Second pass narrative.');
    expect(second.narrativeText).not.toBe('A hand-edited correction.');
    // The captions are replaced too, not left over from the first pass.
    expect(second.narrativeCaptions).toEqual([
      { captureId: 'gen-cap-a', caption: 'A second-pass caption.' },
    ]);
  });
});

describe('PATCH /admin/storyboards/:id/narrative', () => {
  let draft;

  beforeEach(async () => {
    await seedUpload('edit-cap-a', 'narrative-proj', { uploadedAt: '2026-09-01T09:00:00.000Z' });
    draft = await createDraft('narrative-proj');
  });

  afterEach(async () => {
    await db.collection(collections.UPLOADS).doc('edit-cap-a').delete();
    await db.collection(collections.STORYBOARD_DRAFTS).doc(draft.id).delete();
  });

  test('404 — no such draft', async () => {
    const res = await request(app)
      .patch('/admin/storyboards/no-such-draft/narrative')
      .set(HEADERS.analyst)
      .send({ narrativeText: 'Edited.' });
    expect(res.status).toBe(404);
  });

  test('403 — draft belongs to another workspace', async () => {
    const foreignRef = db.collection(collections.STORYBOARD_DRAFTS).doc();
    await foreignRef.set({
      projectId: 'narrative-proj-foreign',
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
      .patch(`/admin/storyboards/${foreignRef.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ narrativeText: 'Edited.' });
    expect(res.status).toBe(403);
    await foreignRef.delete();
  });

  test('403 — a plain user cannot edit the narrative', async () => {
    const res = await request(app)
      .patch(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.user)
      .send({ narrativeText: 'Edited.' });
    expect(res.status).toBe(403);
  });

  test('400 — editing a draft with no narrative yet is rejected, not silently accepted', async () => {
    const res = await request(app)
      .patch(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ narrativeText: 'There is nothing to edit yet.' });
    expect(res.status).toBe(400);

    const getRes = await request(app).get(`/admin/storyboards/${draft.id}`).set(HEADERS.analyst);
    expect(getRes.body.narrativeText).toBeNull();
  });

  test('400 — narrativeText must be a string', async () => {
    await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ prompt: 'Generate first.' });
    await pollUntilSettled(draft.id);

    const res = await request(app)
      .patch(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ narrativeText: 12345 });
    expect(res.status).toBe(400);
  });

  test('an edit persists and survives a re-fetch of the draft', async () => {
    await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ prompt: 'Generate first.' });
    await pollUntilSettled(draft.id);

    const patchRes = await request(app)
      .patch(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ narrativeText: 'The Analyst corrected the wrong claim by hand.' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.narrativeText).toBe('The Analyst corrected the wrong claim by hand.');
    expect(patchRes.body.narrativeStatus).toBe('done');

    const getRes = await request(app).get(`/admin/storyboards/${draft.id}`).set(HEADERS.analyst);
    expect(getRes.body.narrativeText).toBe('The Analyst corrected the wrong claim by hand.');
  });
});
