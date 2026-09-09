/**
 * #96 — the OCR Report the worker actually produces.
 *
 * The evidence lesson 73 asks for, in the only form a test can hold it: the
 * saved artifact body, not the Firestore status. The predecessor of this file
 * asserted that two hardcoded findings came back, which they always did.
 *
 * Firestore: emulator. Cloud Storage and Vertex AI: mocked. No real Vertex
 * call is made by this suite or any other.
 */
'use strict';

jest.mock('@google-cloud/storage', () => {
  const saves = [];
  const objects = new Set();
  function MockFile(bucket, name) {
    this.name = name;
    this.exists = jest.fn(async () => [objects.has(name)]);
    this.save = jest.fn(async (body) => { saves.push({ name, body }); });
  }
  return {
    Storage: jest.fn().mockImplementation(() => ({
      bucket: (bucketName) => ({ file: (name) => new MockFile(bucketName, name) }),
    })),
    __saves: saves,
    __objects: objects,
  };
});
jest.mock('@google/genai', () => require('./helpers/genaiMock').createGenAIMock({ text: '[]' }));

process.env.GCS_BUCKET = 'fake-bucket';

const { __saves, __objects } = require('@google-cloud/storage');
const { db } = require('../src/lib/firestore');
const { getAIClient } = require('../src/lib/vertex');
const collections = require('../src/lib/collections');
const { clearDatabase, seedProject, seedReport } = require('./helpers/fixtures');
const { generateOcrReport, COMPARISON_PROMPT } = require('../src/worker/ocrWorker');
const { DEFAULT_LLM_MODEL, REPORT_MAX_OUTPUT_TOKENS } = require('../src/lib/models');

const PROJECT = 'ocr-project';
const WORKSPACE = 'ocr-workspace';
const DRAFT = 'ocr-draft';

const FINDING = {
  elementType: 'checkbox',
  label: 'Ship to billing address',
  oldState: 'unchecked',
  newState: 'checked',
};

async function seedCapture(id, { abandoned = false } = {}) {
  const path = `${PROJECT}/${id}.png`;
  await db.collection(collections.UPLOADS).doc(id).set({
    projectId: PROJECT, workspaceId: WORKSPACE, userId: 'u1',
    tool: 'Softomedia', stage: '', tabUrl: 'https://example.test/',
    path, bucket: 'fake-bucket', size: 10,
    uploadedAt: new Date('2026-09-01T10:00:00.000Z').toISOString(),
    hasSemanticData: false, schemaVersion: 1,
  });
  if (!abandoned) __objects.add(path);
}

async function seedDraft(captureIds, { projectId = PROJECT, notes = {} } = {}) {
  await db.collection(collections.STORYBOARD_DRAFTS).doc(DRAFT).set({
    projectId,
    workspaceId: WORKSPACE,
    captures: captureIds.map((id, i) => ({
      captureId: id, order: i + 1, included: true, note: notes[id] ?? '',
    })),
    schemaVersion: 1,
  });
}

async function seedCaptures(n, abandoned = []) {
  const ids = [];
  for (let i = 1; i <= n; i += 1) {
    const id = `c${i}`;
    await seedCapture(id, { abandoned: abandoned.includes(id) });
    ids.push(id);
  }
  return ids;
}

function lastArtifact() {
  return JSON.parse(__saves[__saves.length - 1].body);
}

function callArgs() {
  return getAIClient().models.generateContent.mock.calls.map((c) => c[0]);
}

/** Never actually waits: the retry delays are real seconds. */
const noSleep = { sleep: async () => {} };

beforeEach(async () => {
  await clearDatabase();
  __saves.length = 0;
  __objects.clear();
  const { generateContent } = getAIClient().models;
  generateContent.mockReset();
  generateContent.mockResolvedValue({ text: '[]' });
  await seedProject(PROJECT, { workspaceId: WORKSPACE });
});

afterAll(async () => {
  await clearDatabase();
});

describe('the request that reaches Vertex', () => {
  test('both Captures are sent as images, in Storyboard order', async () => {
    await seedCaptures(2);
    await seedDraft(['c1', 'c2']);
    await seedReport('r-1', { projectId: PROJECT, workspaceId: WORKSPACE });

    await generateOcrReport('r-1', PROJECT, 'storyboard_changes', DRAFT, noSleep);

    const parts = callArgs()[0].contents[0].parts;
    expect(parts.filter((p) => p.fileData)).toHaveLength(2);
    expect(parts[1].fileData.fileUri).toBe(`gs://fake-bucket/${PROJECT}/c1.png`);
    expect(parts[2].fileData.fileUri).toBe(`gs://fake-bucket/${PROJECT}/c2.png`);
  });

  test("the Analyst's notes are never shown to the model", async () => {
    // A note is the Analyst's claim about what a step does. Handing it to a
    // model asked what changed is leading the witness, and it will oblige.
    await seedCaptures(2);
    await seedDraft(['c1', 'c2'], { notes: { c2: 'user accepts the terms and conditions' } });
    await seedReport('r-notes', { projectId: PROJECT, workspaceId: WORKSPACE });

    await generateOcrReport('r-notes', PROJECT, 'storyboard_changes', DRAFT, noSleep);

    expect(JSON.stringify(callArgs())).not.toContain('accepts the terms');
  });

  test('the prompt allows an empty answer and forbids narrating intent', async () => {
    expect(COMPARISON_PROMPT).toMatch(/empty list is a correct answer/i);
    expect(COMPARISON_PROMPT).toMatch(/what happens next/i);
  });

  test('an element appearing in only one screenshot is still a change', () => {
    // The first version of this prompt asked for elements visible in *both*,
    // which is grounded and useless: verified against real Captures, a modal
    // opening with three new text fields reported nothing at all, because the
    // fields appear in only one of the two images. Visible *somewhere* is the
    // grounding that matters; "not present" is the honest word for the other
    // side, and saying so explicitly keeps it from being invented as a value.
    expect(COMPARISON_PROMPT).toMatch(/at least one of the two screenshots/i);
    expect(COMPARISON_PROMPT).toMatch(/"not present"/);
    expect(COMPARISON_PROMPT).not.toMatch(/see in both/i);
  });

  test("the Project's own model is used, with room for a thinking model to think", async () => {
    await seedProject('p-pro', { workspaceId: WORKSPACE, llmModel: 'gemini-2.5-pro' });
    await seedCaptures(2);
    await seedDraft(['c1', 'c2'], { projectId: 'p-pro' });
    await seedReport('r-model', { projectId: 'p-pro', workspaceId: WORKSPACE });

    await generateOcrReport('r-model', 'p-pro', 'storyboard_changes', DRAFT, noSleep);

    expect(callArgs()[0].model).toBe('gemini-2.5-pro');
    expect(callArgs()[0].config.maxOutputTokens).toBe(REPORT_MAX_OUTPUT_TOKENS);
  });

  test('one call per pair, not one per Capture', async () => {
    await seedCaptures(4);
    await seedDraft(['c1', 'c2', 'c3', 'c4']);
    await seedReport('r-count', { projectId: PROJECT, workspaceId: WORKSPACE });

    await generateOcrReport('r-count', PROJECT, 'storyboard_changes', DRAFT, noSleep);

    expect(callArgs()).toHaveLength(3);
  });
});

describe('the artifact', () => {
  test('every finding is anchored to the two Captures it came from', async () => {
    getAIClient().models.generateContent.mockResolvedValue({ text: JSON.stringify([FINDING]) });
    await seedCaptures(2);
    await seedDraft(['c1', 'c2'], { notes: { c1: 'the empty form', c2: 'after checking the box' } });
    await seedReport('r-anchor', { projectId: PROJECT, workspaceId: WORKSPACE });

    await generateOcrReport('r-anchor', PROJECT, 'storyboard_changes', DRAFT, noSleep);

    const saved = lastArtifact();
    expect(saved.comparisons).toHaveLength(1);
    expect(saved.comparisons[0].from).toEqual({ captureId: 'c1', order: 1, note: 'the empty form' });
    expect(saved.comparisons[0].to).toEqual({ captureId: 'c2', order: 2, note: 'after checking the box' });
    expect(saved.comparisons[0].findings).toEqual([FINDING]);
    expect(saved.storyboardId).toBe(DRAFT);
    expect(saved.modelUsed).toBe(DEFAULT_LLM_MODEL);
  });

  test('a pair where nothing changed is recorded, not omitted', async () => {
    // "No change between steps 7 and 8" is a real observation about a
    // workflow. An absent finding and an unexamined pair must not look alike.
    await seedCaptures(3);
    await seedDraft(['c1', 'c2', 'c3']);
    await seedReport('r-empty', { projectId: PROJECT, workspaceId: WORKSPACE });

    await generateOcrReport('r-empty', PROJECT, 'storyboard_changes', DRAFT, noSleep);

    const saved = lastArtifact();
    expect(saved.comparisons).toHaveLength(2);
    expect(saved.comparisons.every((c) => c.findings.length === 0)).toBe(true);
  });

  test('coverage says how much of the workflow was examined', async () => {
    await seedCaptures(4, ['c3']);
    await seedDraft(['c1', 'c2', 'c3', 'c4']);
    await seedReport('r-cov', { projectId: PROJECT, workspaceId: WORKSPACE });

    await generateOcrReport('r-cov', PROJECT, 'storyboard_changes', DRAFT, noSleep);

    expect(lastArtifact().coverage).toEqual({
      includedCaptures: 4,
      droppedCaptures: 1,
      availablePairs: 1,
      comparedPairs: 1,
      maxPairs: expect.any(Number),
      capped: false,
    });
  });

  test('a comparison the model failed says so instead of reading as no change', async () => {
    const { generateContent } = getAIClient().models;
    generateContent
      .mockResolvedValueOnce({ text: JSON.stringify([FINDING]) })
      .mockRejectedValueOnce(new Error('deadline exceeded'));
    await seedCaptures(3);
    await seedDraft(['c1', 'c2', 'c3']);
    await seedReport('r-partial', { projectId: PROJECT, workspaceId: WORKSPACE });

    await generateOcrReport('r-partial', PROJECT, 'storyboard_changes', DRAFT, noSleep);

    const saved = lastArtifact();
    expect(saved.comparisons[0].findings).toEqual([FINDING]);
    expect(saved.comparisons[1].findings).toEqual([]);
    expect(saved.comparisons[1].error).toMatch(/deadline exceeded/);
  });

  test('the Report is marked done and points at the artifact', async () => {
    await seedCaptures(2);
    await seedDraft(['c1', 'c2']);
    await seedReport('r-done', { projectId: PROJECT, workspaceId: WORKSPACE });

    await generateOcrReport('r-done', PROJECT, 'storyboard_changes', DRAFT, noSleep);

    const row = (await db.collection(collections.REPORTS).doc('r-done').get()).data();
    expect(row.status).toBe('done');
    expect(row.gcsPath).toBe(`gs://fake-bucket/${PROJECT}/reports/r-done.json`);
  });
});

describe('rate limiting', () => {
  test('a RESOURCE_EXHAUSTED burst is retried rather than lost', async () => {
    const { generateContent } = getAIClient().models;
    generateContent
      .mockRejectedValueOnce(Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }))
      .mockResolvedValue({ text: JSON.stringify([FINDING]) });
    await seedCaptures(2);
    await seedDraft(['c1', 'c2']);
    await seedReport('r-429', { projectId: PROJECT, workspaceId: WORKSPACE });

    await generateOcrReport('r-429', PROJECT, 'storyboard_changes', DRAFT, noSleep);

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(lastArtifact().comparisons[0].findings).toEqual([FINDING]);
  });

  test('a permission failure is not retried — it fails the same way every time', async () => {
    const { generateContent } = getAIClient().models;
    generateContent.mockRejectedValue(Object.assign(new Error('PERMISSION_DENIED'), { status: 403 }));
    await seedCaptures(2);
    await seedDraft(['c1', 'c2']);
    await seedReport('r-403', { projectId: PROJECT, workspaceId: WORKSPACE });

    await generateOcrReport('r-403', PROJECT, 'storyboard_changes', DRAFT, noSleep);

    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

describe('refusing', () => {
  test('a Storyboard with one included Capture fails with a reason the Analyst can act on', async () => {
    await seedCaptures(2);
    await db.collection(collections.STORYBOARD_DRAFTS).doc(DRAFT).set({
      projectId: PROJECT, workspaceId: WORKSPACE, schemaVersion: 1,
      captures: [
        { captureId: 'c1', order: 1, included: true, note: '' },
        { captureId: 'c2', order: 2, included: false, note: '' },
      ],
    });
    await seedReport('r-few', { projectId: PROJECT, workspaceId: WORKSPACE });

    await generateOcrReport('r-few', PROJECT, 'storyboard_changes', DRAFT, noSleep);

    const row = (await db.collection(collections.REPORTS).doc('r-few').get()).data();
    expect(row.status).toBe('error');
    expect(row.error).toMatch(/at least two included Captures/);
    expect(__saves).toHaveLength(0);
    expect(getAIClient().models.generateContent).not.toHaveBeenCalled();
  });

  test("a Storyboard from another Project is refused, not read", async () => {
    await seedCaptures(2);
    await seedDraft(['c1', 'c2'], { projectId: 'someone-elses-project' });
    await seedReport('r-foreign', { projectId: PROJECT, workspaceId: WORKSPACE });

    await generateOcrReport('r-foreign', PROJECT, 'storyboard_changes', DRAFT, noSleep);

    const row = (await db.collection(collections.REPORTS).doc('r-foreign').get()).data();
    expect(row.status).toBe('error');
    expect(getAIClient().models.generateContent).not.toHaveBeenCalled();
  });

  test('a Storyboard that does not exist fails rather than throwing past the handler', async () => {
    await seedReport('r-nodraft', { projectId: PROJECT, workspaceId: WORKSPACE });

    await generateOcrReport('r-nodraft', PROJECT, 'storyboard_changes', 'no-such-draft', noSleep);

    const row = (await db.collection(collections.REPORTS).doc('r-nodraft').get()).data();
    expect(row.status).toBe('error');
  });
});
