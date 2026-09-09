/**
 * #96 — how an OCR Report is asked for.
 *
 * Supersedes tests/reports-ocr-unimplemented.test.js, which held the interim
 * behaviour: `POST /admin/reports/generate` answered 501 for the two OCR types
 * rather than serving the fabricated findings `ocrWorker.js` used to return.
 * Both of those types are now retired and the worker reads real Captures.
 *
 * The contract this file holds (ADR 0017):
 *
 *  - One report type, `storyboard_changes`, replacing the two that were never
 *    two analyses.
 *  - It names a **Storyboard**, not a Project. The Analyst decided which
 *    Captures belong together and in what order; pairing a Project's Captures
 *    by time compares unrelated pages.
 *  - A `dateRange` alongside a `storyboardId` is refused rather than resolved:
 *    the Storyboard's membership *is* the selection (#95).
 *  - Everything is checked before the row is written, for #105's reason.
 *
 * Firestore: emulator. Cloud Storage and Vertex AI: mocked.
 */
'use strict';

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock());
jest.mock('@google/genai', () => require('./helpers/genaiMock').createGenAIMock());

process.env.GCS_BUCKET = 'fake-bucket';
process.env.INTERNAL_SECRET = 'test-internal-secret';

const request = require('supertest');
const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const collections = require('../src/lib/collections');
const { clearDatabase, seedUser, seedProject } = require('./helpers/fixtures');

const WORKSPACE = 'ocr-req-workspace';
const PROJECT = 'ocr-req-project';
const OTHER_PROJECT = 'ocr-req-other-project';
const DRAFT = 'ocr-req-draft';
const OTHER_DRAFT = 'ocr-req-other-draft';

const OCR_TYPE = 'storyboard_changes';
const ANALYST = { 'x-dev-user-email': 'ocr-req-analyst@test.com', 'content-type': 'application/json' };
// analystReportLimiter allows 10 generate calls an hour per user and, unlike
// exportLimiter, deliberately does not skip in tests (rateLimiters.js says so
// in as many words). It keys on the caller, so the blocks below that would
// take this suite past ten use a second Analyst rather than weakening the
// limiter or thinning the coverage.
const ANALYST_2 = { 'x-dev-user-email': 'ocr-req-analyst-2@test.com', 'content-type': 'application/json' };

async function seedDraft(id, projectId) {
  await db.collection(collections.STORYBOARD_DRAFTS).doc(id).set({
    projectId,
    workspaceId: WORKSPACE,
    captures: [
      { captureId: 'c1', order: 1, included: true, note: '' },
      { captureId: 'c2', order: 2, included: true, note: '' },
    ],
    schemaVersion: 1,
  });
}

beforeAll(async () => {
  await clearDatabase();
  await seedUser('ocr-req-analyst-id', {
    email: 'ocr-req-analyst@test.com', role: 'analyst', workspaceId: WORKSPACE,
  });
  await seedUser('ocr-req-analyst-2-id', {
    email: 'ocr-req-analyst-2@test.com', role: 'analyst', workspaceId: WORKSPACE,
  });
  await seedProject(PROJECT, { name: 'Captured work', workspaceId: WORKSPACE });
  // Same Workspace, different Project: the Storyboard check is per Project, so
  // a Workspace-mate's Storyboard must not be usable either.
  await seedProject(OTHER_PROJECT, { name: 'Other work', workspaceId: WORKSPACE });
  await seedDraft(DRAFT, PROJECT);
  await seedDraft(OTHER_DRAFT, OTHER_PROJECT);
});

afterAll(async () => {
  await clearDatabase();
});

function generate(body, who = ANALYST) {
  return request(app).post('/admin/reports/generate').set(who).send(body);
}

describe('the two report types that were never two analyses', () => {
  test.each(['ui_state_changes', 'text_entry_tracking'])(
    '%s is gone, and says what replaced it',
    async (reportType) => {
      const res = await generate({ projectId: PROJECT, reportType });

      expect(res.status).toBe(410);
      expect(res.body.error).toContain(OCR_TYPE);
    }
  );

  test('a retired type files no report row', async () => {
    const before = (await db.collection(collections.REPORTS).get()).size;

    await generate({ projectId: PROJECT, reportType: 'ui_state_changes' });

    expect((await db.collection(collections.REPORTS).get()).size).toBe(before);
  });
});

describe('naming the Storyboard', () => {
  test('an OCR Report without a storyboardId is refused', async () => {
    const res = await generate({ projectId: PROJECT, reportType: OCR_TYPE });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/storyboardId/);
  });

  test('a storyboardId and a dateRange together are refused, not reconciled', async () => {
    const res = await generate({
      projectId: PROJECT, reportType: OCR_TYPE, storyboardId: DRAFT,
      dateRange: { from: '2026-09-01', to: '2026-09-08' },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Storyboard is the selection/i);
  });

  test("a Storyboard belonging to another Project is refused", async () => {
    const res = await generate({
      projectId: PROJECT, reportType: OCR_TYPE, storyboardId: OTHER_DRAFT,
    });

    expect(res.status).toBe(403);
  });

  test('a Storyboard that does not exist is refused identically', async () => {
    // One answer for unreachable (lib/ownership.js): the status code must not
    // sort real Storyboard ids from imaginary ones.
    const res = await generate({
      projectId: PROJECT, reportType: OCR_TYPE, storyboardId: 'no-such-draft',
    });

    expect(res.status).toBe(403);
  });

  test('none of those refusals leaves a report row behind', async () => {
    const before = (await db.collection(collections.REPORTS).get()).size;

    await generate({ projectId: PROJECT, reportType: OCR_TYPE });
    await generate({ projectId: PROJECT, reportType: OCR_TYPE, storyboardId: 'no-such-draft' });
    await generate({ projectId: PROJECT, reportType: OCR_TYPE, storyboardId: OTHER_DRAFT });

    expect((await db.collection(collections.REPORTS).get()).size).toBe(before);
  });
});

describe('a request that is allowed through', () => {
  test('the report row records which Storyboard it walks', async () => {
    const res = await generate({
      projectId: PROJECT, reportType: OCR_TYPE, storyboardId: DRAFT,
    }, ANALYST_2);

    expect(res.status).toBe(202);
    const row = (await db.collection(collections.REPORTS).doc(res.body.reportId).get()).data();
    expect(row.storyboardId).toBe(DRAFT);
    expect(row.reportType).toBe(OCR_TYPE);
    expect(row.workspaceId).toBe(WORKSPACE);
    expect(row.status).toBe('queued');
  });

  test('a standard report still needs no Storyboard and stores none', async () => {
    const res = await generate({ projectId: PROJECT, reportType: 'project_progress' }, ANALYST_2);

    expect(res.status).toBe(202);
    const row = (await db.collection(collections.REPORTS).doc(res.body.reportId).get()).data();
    expect(row.storyboardId).toBeNull();
  });
});

describe('tenancy', () => {
  test("another Customer's Project is refused before the Storyboard is even looked at", async () => {
    await seedProject('foreign-project', { name: 'Theirs', workspaceId: 'another-workspace' });

    const res = await generate({
      projectId: 'foreign-project', reportType: OCR_TYPE, storyboardId: DRAFT,
    }, ANALYST_2);

    expect(res.status).toBe(403);
  });
});
