/**
 * An Analyst corrects one Caption by hand (#129).
 *
 * PATCH /admin/storyboards/:id/captions takes `{ captureId, caption }` and
 * writes that one Caption, marked edited. It is its own route rather than part
 * of the draft PATCH because generation writes the same field: a page holding
 * stale Captions and saving the whole draft would overwrite a regeneration that
 * finished in the background.
 *
 * The decisions are in #129's 2026-09-13 comment. `captureId` travels in the
 * body, not the path, because it is already a percent-encoded object path.
 *
 * Firestore: emulator. Cloud Storage: mocked. Vertex AI: mocked, and the shared
 * double captions every slide it was sent (see helpers/genaiMock.js).
 */
'use strict';

const request = require('supertest');

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock({
  signedUrlPrefix: 'https://storage.googleapis.com/fake-bucket/'
}));
jest.mock('@google/genai', () => require('./helpers/genaiMock').createGenAIMock({
  text: 'Canned synthesis.'
}));

process.env.GCS_BUCKET = 'fake-bucket';

const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const collections = require('../src/lib/collections');
const { clearDatabase, seedUser, seedProject, HEADERS } = require('./helpers/fixtures');

const CAPTURE_IDS = ['cap-edit-a', 'cap-edit-b'];

async function seedUpload(id, uploadedAt) {
  await db.collection(collections.UPLOADS).doc(id).set({
    projectId: 'captions-proj',
    userId: 'analyst-fixture-id',
    tool: 'Softomedia',
    stage: 'beginning',
    tabUrl: 'https://softomedia.example/campaigns',
    path: `captions-proj/${id}.png`,
    gcsPath: `captions-proj/${id}.png`,
    bucket: 'fake-bucket',
    size: 1234,
    hasSemanticData: false,
    schemaVersion: 1,
    uploadedAt,
  });
}

async function getDraft(id, headers = HEADERS.analyst) {
  return (await request(app).get(`/admin/storyboards/${id}`).set(headers)).body;
}

async function pollUntilSettled(id, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const draft = await getDraft(id);
    if (draft.narrativeStatus === 'done' || draft.narrativeStatus === 'error') return draft;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`narrative for draft ${id} never settled`);
}

/** A draft of both Captures with a finished narrative, as the builder sees it. */
async function generatedDraft() {
  const created = await request(app)
    .post('/admin/projects/captions-proj/storyboards')
    .set(HEADERS.analyst);
  await request(app)
    .post(`/admin/storyboards/${created.body.id}/narrative`)
    .set(HEADERS.analyst)
    .send({ prompt: 'Tell the story.' });
  return pollUntilSettled(created.body.id);
}

/** Ticks or unticks one slide through the builder's own save. */
async function setIncluded(draft, captureId, included) {
  const captures = draft.captures.map((c) => ({
    captureId: c.captureId,
    order: c.order,
    included: c.captureId === captureId ? included : c.included,
    note: c.note,
  }));
  const res = await request(app)
    .patch(`/admin/storyboards/${draft.id}`)
    .set(HEADERS.analyst)
    .send({ captures, workflows: draft.workflows });
  expect(res.status).toBe(200);
}

function editCaption(draftId, body, headers = HEADERS.analyst) {
  return request(app).patch(`/admin/storyboards/${draftId}/captions`).set(headers).send(body);
}

const captionOf = (draft, captureId) => draft.narrativeCaptions.find((c) => c.captureId === captureId);

beforeAll(async () => {
  await clearDatabase();
  await seedUser('analyst-fixture-id', { email: 'analyst-fixture@test.com', role: 'analyst' });
  await seedUser('user-fixture-id', { email: 'user-fixture@test.com', role: 'user' });
  await seedProject('captions-proj', { name: 'Captions Project' });
  await seedUpload(CAPTURE_IDS[0], '2026-09-01T09:00:00.000Z');
  await seedUpload(CAPTURE_IDS[1], '2026-09-01T09:05:00.000Z');
});

afterAll(async () => {
  await clearDatabase();
});

afterEach(async () => {
  const drafts = await db.collection(collections.STORYBOARD_DRAFTS).get();
  await Promise.all(drafts.docs.map((d) => d.ref.delete()));
});

describe('PATCH /admin/storyboards/:id/captions: who may edit', () => {
  test('404: no such draft', async () => {
    const res = await editCaption('no-such-draft', { captureId: CAPTURE_IDS[0], caption: 'Edited.' });
    expect(res.status).toBe(404);
  });

  test('403: the draft belongs to another workspace', async () => {
    const foreign = db.collection(collections.STORYBOARD_DRAFTS).doc();
    await foreign.set({
      projectId: 'captions-proj-foreign',
      workspaceId: 'other-workspace',
      status: 'draft',
      captures: [{ captureId: CAPTURE_IDS[0], order: 1, included: true, note: '' }],
      narrativeStatus: 'done',
      narrativeText: 'Existing synthesis.',
      narrativeCaptions: [{ captureId: CAPTURE_IDS[0], caption: 'Existing caption.' }],
      createdBy: 'someone-else',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    const res = await editCaption(foreign.id, { captureId: CAPTURE_IDS[0], caption: 'Edited.' });
    expect(res.status).toBe(403);
  });

  test('403: a plain user cannot edit a Caption', async () => {
    const draft = await generatedDraft();
    const res = await editCaption(draft.id, { captureId: CAPTURE_IDS[0], caption: 'Edited.' }, HEADERS.user);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /admin/storyboards/:id/captions: what is refused', () => {
  // Queued and generating: the words are about to be replaced. Error: the stored
  // Captions are the previous run's leftovers, since queueing blanks the synthesis
  // but not the Captions.
  test.each(['queued', 'generating', 'error'])('400 while the narrative is %s, and nothing is written', async (status) => {
    const draft = await generatedDraft();
    await db.collection(collections.STORYBOARD_DRAFTS).doc(draft.id).update({ narrativeStatus: status });

    const res = await editCaption(draft.id, { captureId: CAPTURE_IDS[0], caption: 'Too early.' });

    expect(res.status).toBe(400);
    expect(captionOf(await getDraft(draft.id), CAPTURE_IDS[0])).toEqual(captionOf(draft, CAPTURE_IDS[0]));
  });

  test.each([
    ['only whitespace', '   '],
    ['empty', ''],
    ['not a string', 42],
    ['missing', undefined],
  ])('400 when the Caption is %s: one can be rewritten, never blanked', async (_label, caption) => {
    const draft = await generatedDraft();

    const res = await editCaption(draft.id, { captureId: CAPTURE_IDS[0], caption });

    expect(res.status).toBe(400);
    expect(captionOf(await getDraft(draft.id), CAPTURE_IDS[0])).toEqual(captionOf(draft, CAPTURE_IDS[0]));
  });

  // The PDF cell and the video's slide timing were both sized for this many
  // words (lib/models.js). 46 is written out rather than derived from the
  // constant, so the test disagrees with the code if the constant moves.
  test('400 for a Caption over 45 words, and nothing is written', async () => {
    const draft = await generatedDraft();

    const res = await editCaption(draft.id, { captureId: CAPTURE_IDS[0], caption: Array(46).fill('word').join(' ') });

    expect(res.status).toBe(400);
    expect(captionOf(await getDraft(draft.id), CAPTURE_IDS[0])).toEqual(captionOf(draft, CAPTURE_IDS[0]));
  });

  test('a Caption of exactly 45 words is accepted, however it is spaced', async () => {
    const draft = await generatedDraft();
    const caption = Array(45).fill('word').join(' \n ');

    const res = await editCaption(draft.id, { captureId: CAPTURE_IDS[0], caption });

    expect(res.status).toBe(200);
  });

  test('400 for a Capture that is not in the draft, and nothing is written', async () => {
    const draft = await generatedDraft();

    const res = await editCaption(draft.id, { captureId: 'not-in-this-draft', caption: 'Stray.' });

    expect(res.status).toBe(400);
    expect((await getDraft(draft.id)).narrativeCaptions).toEqual(draft.narrativeCaptions);
  });

});

describe('PATCH /admin/storyboards/:id/captions: which slides', () => {
  // Ticking a slide is saved by the builder's Save button, a Caption on leaving
  // its box. A slide ticked back in on the page but not yet saved is excluded in
  // the stored draft, and refusing it would answer a visible box with a 400.
  test('a slide excluded in the saved draft can still have its Caption saved', async () => {
    const draft = await generatedDraft();
    await setIncluded(draft, CAPTURE_IDS[1], false);

    const res = await editCaption(draft.id, { captureId: CAPTURE_IDS[1], caption: 'Ticked back in, not yet saved.' });

    expect(res.status).toBe(200);
    expect(captionOf(await getDraft(draft.id), CAPTURE_IDS[1]).caption).toBe('Ticked back in, not yet saved.');
  });

  // A draft generated before #124 has a synthesis and no Captions at all.
  test('a draft with no Captions at all takes a first one, marked edited', async () => {
    const draft = await generatedDraft();
    await db.collection(collections.STORYBOARD_DRAFTS).doc(draft.id).update({ narrativeCaptions: null });

    const res = await editCaption(draft.id, { captureId: CAPTURE_IDS[0], caption: 'The first Caption.' });

    expect(res.status).toBe(200);
    expect((await getDraft(draft.id)).narrativeCaptions).toEqual([
      { captureId: CAPTURE_IDS[0], caption: 'The first Caption.', edited: true },
    ]);
  });
});

describe('PATCH /admin/storyboards/:id/captions', () => {
  test('writes the one Caption, marks it edited, and leaves the other alone', async () => {
    const draft = await generatedDraft();
    const untouched = captionOf(draft, CAPTURE_IDS[1]);

    const res = await editCaption(draft.id, { captureId: CAPTURE_IDS[0], caption: 'The Analyst fixed this.' });

    expect(res.status).toBe(200);
    const after = await getDraft(draft.id);
    expect(captionOf(after, CAPTURE_IDS[0])).toEqual({
      captureId: CAPTURE_IDS[0], caption: 'The Analyst fixed this.', edited: true,
    });
    expect(captionOf(after, CAPTURE_IDS[1])).toEqual(untouched);
    expect(after.narrativeText).toBe(draft.narrativeText);
  });

  test('writes a Caption for a slide ticked back in after generation, marked edited', async () => {
    const created = await request(app)
      .post('/admin/projects/captions-proj/storyboards')
      .set(HEADERS.analyst);
    await setIncluded(created.body, CAPTURE_IDS[1], false);
    await request(app)
      .post(`/admin/storyboards/${created.body.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ prompt: 'Tell the story.' });
    const generated = await pollUntilSettled(created.body.id);
    expect(captionOf(generated, CAPTURE_IDS[1])).toBeUndefined();
    await setIncluded(generated, CAPTURE_IDS[1], true);

    const res = await editCaption(generated.id, { captureId: CAPTURE_IDS[1], caption: 'Written by hand.' });

    expect(res.status).toBe(200);
    const after = await getDraft(generated.id);
    expect(captionOf(after, CAPTURE_IDS[1])).toEqual({
      captureId: CAPTURE_IDS[1], caption: 'Written by hand.', edited: true,
    });
  });

  // Decided on #129: regeneration replaces every Caption, corrected ones
  // included. The portal warns with a count first; the server does not merge.
  test('regenerating replaces a corrected Caption, which is then no longer marked edited', async () => {
    const draft = await generatedDraft();
    await editCaption(draft.id, { captureId: CAPTURE_IDS[0], caption: 'The Analyst fixed this.' });

    await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative`)
      .set(HEADERS.analyst)
      .send({ prompt: 'Tell it again.' });
    const regenerated = await pollUntilSettled(draft.id);

    expect(captionOf(regenerated, CAPTURE_IDS[0])).toEqual({
      captureId: CAPTURE_IDS[0], caption: 'Canned caption for slide 1.',
    });
  });
});
