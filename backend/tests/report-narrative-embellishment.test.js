/**
 * #119 — the narrative must not invent what the metrics do not say.
 *
 * The first real Report this product ever produced ended with "We are focused
 * on onboarding additional team members in the coming days". The metrics
 * handed to the model were `{"totalCaptures":8,"activeUsers":1}`. Nothing in
 * the system holds such a plan; the model supplied a plausible business
 * commitment because the prompt asked it for an executive assistant's *voice*
 * rather than for a description.
 *
 * This is #8 and #96's defect class one layer up: the numbers are honest, the
 * prose around them is not. A Report is something a Customer reads and may
 * forward, so a sentence stating an intention they never expressed is the
 * product putting words in their mouth.
 *
 * ADR 0016 records why this is *detected* rather than only discouraged by the
 * prompt: prompt wording cannot be asserted to have worked, and the narrative
 * below is exactly what a well-behaved prompt still produced.
 *
 * Firestore: emulator. Cloud Storage and Vertex AI: mocked.
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
  findForwardLookingClaims, describeMeasuredValues, buildReportNarrativePrompt,
} = require('../src/lib/narrativeGuard');

/** The artifact from `gs://.../reports/wGQYWqBgEtv2iiGHKe9I.json`, verbatim. */
const THE_REAL_ONE = 'The project is currently underway with one active user who has '
  + 'successfully secured eight total captures to date. While initial progress has '
  + 'commenced, activity remains concentrated within a single contributor. We are '
  + 'focused on onboarding additional team members in the coming days to accelerate '
  + 'momentum.';

const FAITHFUL = 'This Project has recorded 8 total captures. Those captures came '
  + 'from 1 active user.';

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

function lastArtifact() {
  return JSON.parse(__saves[__saves.length - 1].body);
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

describe('what counts as a claim the metrics cannot support', () => {
  test('the sentence that opened this issue is flagged', () => {
    expect(findForwardLookingClaims(THE_REAL_ONE).length).toBeGreaterThan(0);
  });

  test('a faithful restatement of the same metrics is not flagged', () => {
    expect(findForwardLookingClaims(FAITHFUL)).toEqual([]);
  });

  test.each([
    ['a recommendation', 'Captures total 8. We recommend adding more users.'],
    ['a plan',           'Captures total 8. The team plans to expand coverage.'],
    ['a forecast',       'Captures total 8. Activity will increase next month.'],
    ['a next step',      'Captures total 8. Next steps include onboarding.'],
    ['an intention',     'Captures total 8. The project aims to double that.'],
  ])('%s is flagged', (_label, text) => {
    expect(findForwardLookingClaims(text).length).toBeGreaterThan(0);
  });

  test.each([
    ['a bare count',  'This Project recorded 8 total captures.'],
    ['a null metric', 'Median session length was not measured.'],
    ['a rate',        'Capture rate was 4.2 captures per hour across 1 active user.'],
  ])('%s is left alone', (_label, text) => {
    expect(findForwardLookingClaims(text)).toEqual([]);
  });

  test('nothing is flagged in an empty or missing narrative', () => {
    expect(findForwardLookingClaims('')).toEqual([]);
    expect(findForwardLookingClaims(undefined)).toEqual([]);
  });
});

describe('the deterministic restatement that replaces a rejected narrative', () => {
  test('every metric is named, in words, with its value', () => {
    expect(describeMeasuredValues({ totalCaptures: 8, activeUsers: 1 }))
      .toBe('total captures 8, active users 1');
  });

  test('a null metric says it was not measured rather than reporting zero', () => {
    // sessionMetrics returns null where there was nothing to divide by. "0"
    // would be a claim about work nobody measured — reportMetrics.js is
    // explicit about that, and the restatement must not undo it.
    expect(describeMeasuredValues({ capturesPerHour: null, medianSessionLength: '12m 30s' }))
      .toBe('captures per hour not measured, median session length 12m 30s');
  });
});

describe('the prompt', () => {
  test('asks for a description of the metrics, not for a voice', async () => {
    await seedProject('p-prompt', { workspaceId: 'ws-a' });
    await seedUpload('c-1', 'p-prompt', 'user-a');
    await seedReportDoc('r-prompt', 'p-prompt');

    await generateStandardReport('r-prompt', 'p-prompt', 'project_progress', null);

    const sent = JSON.stringify(lastCallArgs().contents);
    expect(sent).not.toMatch(/executive assistant/i);
    expect(sent).toMatch(/recommendation/i);
    expect(sent).toMatch(/forecast/i);
  });

  test('carries the metrics it is describing', () => {
    const prompt = buildReportNarrativePrompt('project_progress', { totalCaptures: 8 });
    expect(prompt).toContain('"totalCaptures":8');
    expect(prompt).toContain('project_progress');
  });
});

describe('what lands in the artifact', () => {
  test('an embellished narrative is rejected and replaced with the measured values', async () => {
    getAIClient().models.generateContent.mockResolvedValueOnce({ text: THE_REAL_ONE });

    await seedProject('p-invented', { workspaceId: 'ws-a' });
    await seedUpload('c-2', 'p-invented', 'user-a');
    await seedReportDoc('r-invented', 'p-invented');

    await generateStandardReport('r-invented', 'p-invented', 'project_progress', null);

    const saved = lastArtifact();
    expect(saved.summary).not.toContain('onboarding additional team members');
    expect(saved.summary).toContain('total captures 1');
    expect(saved.summaryGuard.status).toBe('rejected');
    expect(saved.summaryGuard.markers.length).toBeGreaterThan(0);
    // Kept, so the rejection is diagnosable rather than a narrative that
    // silently went missing — the failure mode this issue's family is made of.
    expect(saved.summaryGuard.rejectedSummary).toBe(THE_REAL_ONE);
  });

  test('a faithful narrative passes through untouched', async () => {
    getAIClient().models.generateContent.mockResolvedValueOnce({ text: FAITHFUL });

    await seedProject('p-faithful', { workspaceId: 'ws-a' });
    await seedUpload('c-3', 'p-faithful', 'user-a');
    await seedReportDoc('r-faithful', 'p-faithful');

    await generateStandardReport('r-faithful', 'p-faithful', 'project_progress', null);

    const saved = lastArtifact();
    expect(saved.summary).toBe(FAITHFUL);
    expect(saved.summaryGuard.status).toBe('accepted');
  });

  test('the guard records that it ran even when it found nothing', async () => {
    // Evidence that the check happened, rather than an absent field that
    // cannot be told apart from a guard that was never wired in (lesson 73).
    await seedProject('p-ran', { workspaceId: 'ws-a' });
    await seedUpload('c-4', 'p-ran', 'user-a');
    await seedReportDoc('r-ran', 'p-ran');

    await generateStandardReport('r-ran', 'p-ran', 'project_progress', null);

    expect(lastArtifact().summaryGuard).toEqual({ status: 'accepted' });
  });

  test('a Project with no Captures is not narrated or guarded at all', async () => {
    await seedProject('p-empty', { workspaceId: 'ws-a' });
    await seedReportDoc('r-empty', 'p-empty');

    await generateStandardReport('r-empty', 'p-empty', 'project_progress', null);

    const saved = lastArtifact();
    expect(saved.summary).toMatch(/nothing to report on yet/);
    expect(saved.summaryGuard).toBeUndefined();
    expect(getAIClient().models.generateContent).not.toHaveBeenCalled();
  });
});
