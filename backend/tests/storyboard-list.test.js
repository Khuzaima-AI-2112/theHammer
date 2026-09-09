/**
 * #96 — GET /admin/projects/:id/storyboards.
 *
 * An OCR Report is generated for a Storyboard (ADR 0017), and until this route
 * existed nothing could enumerate them: the portal held one draft in memory and
 * the only reads were "create or resume" and "fetch by id". A picker needs a
 * list.
 *
 * It also carries the pair cap. ADR 0017 puts that number in lib/models.js, and
 * a portal holding its own copy would keep promising "the first 20" after the
 * backend enforced something else — a wrong statement about what the Report
 * examined.
 *
 * Firestore: emulator. Cloud Storage and Vertex AI: mocked.
 */
'use strict';

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock());
jest.mock('@google/genai', () => require('./helpers/genaiMock').createGenAIMock());

process.env.GCS_BUCKET = 'fake-bucket';

const request = require('supertest');
const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const collections = require('../src/lib/collections');
const { clearDatabase, seedUser, seedProject } = require('./helpers/fixtures');
const { OCR_MAX_PAIRS } = require('../src/lib/models');
const { UNREACHABLE_PROJECT } = require('../src/lib/ownership');

const WORKSPACE = 'sb-list-workspace';
const OTHER_WORKSPACE = 'sb-list-other-workspace';
const PROJECT = 'sb-list-project';
const OTHER_PROJECT = 'sb-list-other-project';

const ANALYST = { 'x-dev-user-email': 'sb-list-analyst@test.com' };

async function seedDraft(id, { projectId, workspaceId, captures, createdAt }) {
  await db.collection(collections.STORYBOARD_DRAFTS).doc(id).set({
    projectId, workspaceId, status: 'draft', createdAt, captures, schemaVersion: 1,
  });
}

function capturesWith(total, included) {
  return Array.from({ length: total }, (_, i) => ({
    captureId: `c${i + 1}`, order: i + 1, included: i < included, note: '',
  }));
}

beforeAll(async () => {
  await clearDatabase();
  await seedUser('sb-list-analyst-id', {
    email: 'sb-list-analyst@test.com', role: 'analyst', workspaceId: WORKSPACE,
  });
  await seedProject(PROJECT, { name: 'Ours', workspaceId: WORKSPACE });
  await seedProject(OTHER_PROJECT, { name: 'Theirs', workspaceId: OTHER_WORKSPACE });

  await seedDraft('sb-old', {
    projectId: PROJECT, workspaceId: WORKSPACE,
    createdAt: '2026-09-01T10:00:00.000Z', captures: capturesWith(4, 3),
  });
  await seedDraft('sb-new', {
    projectId: PROJECT, workspaceId: WORKSPACE,
    createdAt: '2026-09-08T10:00:00.000Z', captures: capturesWith(66, 66),
  });
  await seedDraft('sb-foreign', {
    projectId: OTHER_PROJECT, workspaceId: OTHER_WORKSPACE,
    createdAt: '2026-09-08T11:00:00.000Z', captures: capturesWith(5, 5),
  });
});

afterAll(async () => {
  await clearDatabase();
});

function list(projectId) {
  return request(app).get(`/admin/projects/${projectId}/storyboards`).set(ANALYST);
}

describe('what the picker is given', () => {
  test("only the Project's own Storyboards, newest first", async () => {
    const res = await list(PROJECT);

    expect(res.status).toBe(200);
    expect(res.body.storyboards.map((s) => s.id)).toEqual(['sb-new', 'sb-old']);
    expect(res.body.total).toBe(2);
  });

  test('included Captures are counted separately from total', async () => {
    // The included count is what decides whether a Report can be generated at
    // all, and how much of the workflow it covers.
    const res = await list(PROJECT);

    const old = res.body.storyboards.find((s) => s.id === 'sb-old');
    expect(old).toMatchObject({ totalCaptures: 4, includedCaptures: 3 });
  });

  test('the pair cap travels with the list', async () => {
    const res = await list(PROJECT);

    expect(res.body.maxPairs).toBe(OCR_MAX_PAIRS);
  });

  test('a Project with no Storyboards answers an empty list, not a 404', async () => {
    await seedProject('sb-list-empty', { name: 'Nothing yet', workspaceId: WORKSPACE });

    const res = await list('sb-list-empty');

    expect(res.status).toBe(200);
    expect(res.body.storyboards).toEqual([]);
  });
});

describe('tenancy', () => {
  test("another Customer's Project is refused", async () => {
    const res = await list(OTHER_PROJECT);

    expect(res.status).toBe(UNREACHABLE_PROJECT.status);
    expect(res.body.error).toBe(UNREACHABLE_PROJECT.error);
  });

  test('a Project that does not exist is refused identically', async () => {
    const res = await list('no-such-project');

    expect(res.status).toBe(UNREACHABLE_PROJECT.status);
    expect(res.body.error).toBe(UNREACHABLE_PROJECT.error);
  });

  test("no foreign Storyboard appears in an owned Project's list", async () => {
    const res = await list(PROJECT);

    expect(res.text).not.toContain('sb-foreign');
  });
});
