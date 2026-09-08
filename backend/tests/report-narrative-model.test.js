/**
 * #108 — what the Reports worker actually asks Vertex for.
 *
 * The bug this closes was invisible from the outside: `gemini-1.5-flash` is
 * retired, so the call 404d, and #8's graceful degradation completed the
 * Report with raw metrics and a `summary` explaining nothing. `status: done`
 * was true the whole time (lesson 73). The only observation that would have
 * caught it is the one made here — the arguments handed to the SDK, in the
 * manner #107 established, since the shared mock swallows the call itself.
 *
 * Firestore: emulator. Cloud Storage and Vertex AI: mocked. No real Vertex
 * call is made by this suite or any other.
 */
'use strict';

jest.mock('@google-cloud/storage', () => {
  const saves = [];
  function MockFile(name) {
    this.name = name;
    this.save = jest.fn(async (body) => { saves.push({ name, body }); });
  }
  return {
    Storage: jest.fn().mockImplementation(() => ({
      bucket: () => ({ file: (name) => new MockFile(name) })
    })),
    __saves: saves
  };
});
jest.mock('@google/genai', () => require('./helpers/genaiMock').createGenAIMock({
  text: 'A canned narrative.'
}));

process.env.GCS_BUCKET = 'fake-bucket';

const { __saves } = require('@google-cloud/storage');
const { db } = require('../src/lib/firestore');
const { getAIClient } = require('../src/lib/vertex');
const collections = require('../src/lib/collections');
const { clearDatabase, seedProject } = require('./helpers/fixtures');
const { generateStandardReport } = require('../src/worker/reportsWorker');
const {
  DEFAULT_LLM_MODEL, REPORT_MAX_OUTPUT_TOKENS, RETIRED_MODEL_IDS,
} = require('../src/lib/models');

async function seedUpload(id, projectId, userId) {
  await db.collection(collections.UPLOADS).doc(id).set({
    projectId, userId, tool: 'Softomedia', stage: '',
    tabUrl: 'https://example.test/', path: `${projectId}/${id}.png`,
    bucket: 'fake-bucket', size: 1234,
    uploadedAt: new Date('2026-09-01T10:00:00.000Z').toISOString(),
    hasSemanticData: false, schemaVersion: 1,
  });
}

async function seedReportDoc(id, projectId) {
  await db.collection(collections.REPORTS).doc(id).set({
    projectId, reportType: 'project_progress', dateRange: null,
    status: 'queued', gcsPath: null, requestedBy: 'analyst-fixture-id',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    schemaVersion: 1,
  });
}

function lastCallArgs() {
  const { generateContent } = getAIClient().models;
  return generateContent.mock.calls[generateContent.mock.calls.length - 1][0];
}

beforeEach(async () => {
  await clearDatabase();
  getAIClient().models.generateContent.mockClear();
  __saves.length = 0;
});

afterAll(async () => {
  await clearDatabase();
});

describe('the model id on the wire', () => {
  test('a Project with no llmModel falls back to the supported default', async () => {
    await seedProject('p-default', { workspaceId: 'ws-a' });
    await seedUpload('c-1', 'p-default', 'user-a');
    await seedReportDoc('r-default', 'p-default');

    await generateStandardReport('r-default', 'p-default', 'project_progress', null);

    expect(lastCallArgs().model).toBe(DEFAULT_LLM_MODEL);
  });

  test("a Project's own llmModel is what is asked for", async () => {
    await seedProject('p-configured', { workspaceId: 'ws-a', llmModel: 'gemini-2.5-pro' });
    await seedUpload('c-2', 'p-configured', 'user-a');
    await seedReportDoc('r-configured', 'p-configured');

    await generateStandardReport('r-configured', 'p-configured', 'project_progress', null);

    expect(lastCallArgs().model).toBe('gemini-2.5-pro');
  });

  test('no retired model id ever reaches the SDK', async () => {
    await seedProject('p-retired', { workspaceId: 'ws-a' });
    await seedUpload('c-3', 'p-retired', 'user-a');
    await seedReportDoc('r-retired', 'p-retired');

    await generateStandardReport('r-retired', 'p-retired', 'project_progress', null);

    expect(RETIRED_MODEL_IDS).not.toContain(lastCallArgs().model);
  });
});

describe('the output budget', () => {
  test('maxOutputTokens leaves room for a thinking model to think', async () => {
    // gemini-3.5-flash spends reasoning tokens out of this same budget. A
    // probe with 20 spent 16 thinking and returned no text at all, with
    // finishReason MAX_TOKENS — a structurally valid, empty narrative, which
    // is indistinguishable from the bug this issue exists to end.
    await seedProject('p-budget', { workspaceId: 'ws-a' });
    await seedUpload('c-4', 'p-budget', 'user-a');
    await seedReportDoc('r-budget', 'p-budget');

    await generateStandardReport('r-budget', 'p-budget', 'project_progress', null);

    expect(lastCallArgs().config.maxOutputTokens).toBe(REPORT_MAX_OUTPUT_TOKENS);
    expect(REPORT_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(1024);
  });
});

describe('the narrative that comes back', () => {
  test("the model's text is what lands in the artifact's summary", async () => {
    // The evidence lesson 73 asks for, in the only form a test can hold it:
    // read the saved artifact body, not the Firestore status.
    await seedProject('p-summary', { workspaceId: 'ws-a' });
    await seedUpload('c-5', 'p-summary', 'user-a');
    await seedReportDoc('r-summary', 'p-summary');

    await generateStandardReport('r-summary', 'p-summary', 'project_progress', null);

    const saved = JSON.parse(__saves[__saves.length - 1].body);
    expect(saved.summary).toBe('A canned narrative.');
    expect(saved.modelUsed).toBe(DEFAULT_LLM_MODEL);
  });
});
