/**
 * Recorded audio as an alternate prompt input (#88)
 *
 * POST /admin/storyboards/:id/narrative/audio uploads a short recording,
 * transcribes it via Vertex AI Gemini, and feeds the transcript into the
 * exact same generation path (queueNarrativeGeneration → generateNarrative)
 * a typed prompt takes through POST /admin/storyboards/:id/narrative — no
 * separate audio-driven generation logic exists.
 *
 * Firestore: emulator. Cloud Storage: mocked. Vertex AI (`@google/genai`):
 * mocked — one call transcribes, a second (mocked separately per test)
 * generates the narrative from that transcript.
 */
'use strict';

const request = require('supertest');

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock({
  signedUrlPrefix: 'https://storage.googleapis.com/fake-bucket/'
}));
jest.mock('@google/genai', () => require('./helpers/genaiMock').createGenAIMock({
  text: 'Default canned response.'
}));

process.env.GCS_BUCKET = 'fake-bucket';

const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const { getAIClient } = require('../src/lib/vertex');
const storyboardsRouter = require('../src/routes/admin/storyboards');
const collections = require('../src/lib/collections');
const { clearDatabase, seedUser, seedProject, HEADERS } = require('./helpers/fixtures');

const TINY_WEBM = Buffer.from('fake webm bytes for a short walkthrough');

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

beforeAll(async () => {
  await clearDatabase();
  await seedUser('admin-fixture-id', { email: 'admin-fixture@test.com', role: 'admin' });
  await seedUser('analyst-fixture-id', { email: 'analyst-fixture@test.com', role: 'analyst' });
  await seedUser('user-fixture-id', { email: 'user-fixture@test.com', role: 'user' });
  await seedProject('audio-proj', { name: 'Audio Narrative Project', llmModel: 'gemini-1.5-flash' });
});

afterAll(async () => {
  await clearDatabase();
});

describe('buildTranscriptionRequest', () => {
  test('sends the audio as a gs:// fileData part alongside a verbatim-transcription instruction', () => {
    const req = storyboardsRouter.buildTranscriptionRequest('gs://fake-bucket/audio-proj/draft-1/audio.webm', 'audio/webm');
    const parts = req.contents[0].parts;

    expect(parts[0].text).toMatch(/transcribe/i);
    expect(parts[1]).toEqual({
      fileData: { mimeType: 'audio/webm', fileUri: 'gs://fake-bucket/audio-proj/draft-1/audio.webm' }
    });
  });
});

describe('POST /admin/storyboards/:id/narrative/audio', () => {
  let draft;

  beforeEach(async () => {
    await seedUpload('audio-cap-a', 'audio-proj', { uploadedAt: '2026-09-01T09:00:00.000Z' });
    draft = await createDraft('audio-proj');
  });

  afterEach(async () => {
    await db.collection(collections.UPLOADS).doc('audio-cap-a').delete();
    await db.collection(collections.STORYBOARD_DRAFTS).doc(draft.id).delete();
  });

  test('404 — no such draft', async () => {
    const res = await request(app)
      .post('/admin/storyboards/no-such-draft/narrative/audio')
      .set(HEADERS.analyst)
      .attach('file', TINY_WEBM, { filename: 'walkthrough.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(404);
  });

  test('403 — draft belongs to another workspace', async () => {
    const foreignRef = db.collection(collections.STORYBOARD_DRAFTS).doc();
    await foreignRef.set({
      projectId: 'audio-proj',
      workspaceId: 'other-workspace',
      status: 'draft',
      captures: [],
      createdBy: 'someone-else',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    const res = await request(app)
      .post(`/admin/storyboards/${foreignRef.id}/narrative/audio`)
      .set(HEADERS.analyst)
      .attach('file', TINY_WEBM, { filename: 'walkthrough.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(403);
    await foreignRef.delete();
  });

  test('403 — a plain user cannot upload a recording', async () => {
    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative/audio`)
      .set(HEADERS.user)
      .attach('file', TINY_WEBM, { filename: 'walkthrough.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(403);
  });

  test('400 — no file attached', async () => {
    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative/audio`)
      .set(HEADERS.analyst);
    expect(res.status).toBe(400);
  });

  test('400 — an unsupported audio type is rejected', async () => {
    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative/audio`)
      .set(HEADERS.analyst)
      .attach('file', TINY_WEBM, { filename: 'walkthrough.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  test('413 — a recording over the audio size limit is refused before it is buffered', async () => {
    const OVERSIZED = 15 * 1024 * 1024 + 2 * 1024 * 1024; // MAX_AUDIO_BYTES + 2MB
    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative/audio`)
      .set(HEADERS.analyst)
      .attach('file', Buffer.alloc(OVERSIZED, 1), { filename: 'huge.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(413);
  }, 15000);

  test('202 — accepts a real browser MediaRecorder mimeType carrying a codecs parameter', async () => {
    const client = getAIClient();
    client.models.generateContent
      .mockResolvedValueOnce({ text: 'Transcribed from a codecs-qualified type.' })
      .mockResolvedValueOnce({ text: 'Narrative from codecs-qualified audio.' });

    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative/audio`)
      .set(HEADERS.analyst)
      .attach('file', TINY_WEBM, { filename: 'walkthrough.webm', contentType: 'audio/webm;codecs=opus' });
    expect(res.status).toBe(202);

    const settled = await pollUntilSettled(draft.id);
    expect(settled.narrativeStatus).toBe('done');
    expect(settled.narrativePrompt).toBe('Transcribed from a codecs-qualified type.');
  });

  test('a recorded-audio draft produces the same shape of generation request as a typed-prompt draft, given an equivalent transcript', async () => {
    const client = getAIClient();
    client.models.generateContent.mockClear();
    client.models.generateContent
      .mockResolvedValueOnce({ text: 'The Analyst opened the campaign, then walked through setup.' }) // transcription
      .mockResolvedValueOnce({ text: 'Narrative generated from the audio transcript.' });               // generation

    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative/audio`)
      .set(HEADERS.analyst)
      .attach('file', TINY_WEBM, { filename: 'walkthrough.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(202);

    const settled = await pollUntilSettled(draft.id);
    expect(settled.narrativePrompt).toBe('The Analyst opened the campaign, then walked through setup.');
    expect(settled.narrativeStatus).toBe('done');
    expect(settled.narrativeText).toBe('Narrative generated from the audio transcript.');

    // Same shape a typed-prompt draft would send: buildNarrativeRequest is
    // the one function both entry points call — no audio-specific variant.
    const typedShapeReq = await storyboardsRouter.buildNarrativeRequest(
      { captures: draft.captures },
      settled.narrativePrompt
    );
    const generationCallArgs = client.models.generateContent.mock.calls[1][0];
    expect(generationCallArgs.contents).toEqual(typedShapeReq.contents);
  });

  test('the transcript is visible to the operator via narrativePrompt, the same field a typed prompt uses', async () => {
    const client = getAIClient();
    client.models.generateContent
      .mockResolvedValueOnce({ text: 'Transcribed walkthrough, visible before generation finishes.' })
      .mockResolvedValueOnce({ text: 'Generated narrative.' });

    await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative/audio`)
      .set(HEADERS.analyst)
      .attach('file', TINY_WEBM, { filename: 'walkthrough.webm', contentType: 'audio/webm' });

    const getRes = await request(app).get(`/admin/storyboards/${draft.id}`).set(HEADERS.analyst);
    expect(getRes.body.narrativePrompt).toBe('Transcribed walkthrough, visible before generation finishes.');
  });

  test('a transcription failure surfaces as an explicit error, not a silent fallback to an empty prompt', async () => {
    const client = getAIClient();
    client.models.generateContent.mockClear();
    client.models.generateContent.mockRejectedValueOnce(new Error('Vertex AI audio transcription is unavailable'));

    const res = await request(app)
      .post(`/admin/storyboards/${draft.id}/narrative/audio`)
      .set(HEADERS.analyst)
      .attach('file', TINY_WEBM, { filename: 'walkthrough.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(202);

    const getRes = await request(app).get(`/admin/storyboards/${draft.id}`).set(HEADERS.analyst);
    expect(getRes.body.narrativeStatus).toBe('error');
    expect(getRes.body.narrativeError).toMatch(/transcription failed/i);
    expect(getRes.body.narrativeError).toMatch(/Vertex AI audio transcription is unavailable/);
    // Never falls back to an empty prompt — the field stays whatever it was
    // (null, on a fresh draft) rather than being set to ''.
    expect(getRes.body.narrativePrompt).not.toBe('');
    expect(getRes.body.narrativePrompt).toBeNull();
    expect(getRes.body.narrativeText).toBeNull();

    // Generation was never triggered — only the transcription call happened.
    expect(client.models.generateContent).toHaveBeenCalledTimes(1);
  });
});
