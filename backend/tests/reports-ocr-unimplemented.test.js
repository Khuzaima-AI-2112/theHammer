/**
 * #96 (interim) — the OCR report types refuse rather than fabricate
 *
 * `generateOcrReport` has never read a Capture. It builds a Gemini request
 * with both image parts commented out, never sends it, and returns two
 * hardcoded findings — "Accept Terms and Conditions" unchecked→checked and
 * "Email Address" →user@example.com — for every report, every Project, every
 * time. It then writes them to GCS in an artifact stamped
 * `vertexAiModel: 'gemini-1.5-flash'`, and sets the report to `done`.
 *
 * That is worse than the narrative failure in #107, which at least said
 * "LLM generation failed" in the artifact. These findings name specific UI
 * elements and specific state transitions, so they read as observations of
 * the Customer's own screens rather than as an obvious placeholder — which
 * makes them harder to disbelieve than a wrong number (lesson 66: a comment
 * admitting the code is mocked is an unfiled defect report).
 *
 * Until the real implementation lands, the honest answer is to refuse. The
 * check runs before the report row is written, for the same reason #105's
 * does: a row filed here would sit in the Customer's Reports list describing
 * work that is never going to happen.
 *
 * Offline like the rest of the suite: Firestore is the `demo-hammer` emulator.
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

const WORKSPACE = 'ocr-workspace';
const PROJECT = 'ocr-project';
const ANALYST = { 'x-dev-user-email': 'ocr-analyst@test.com', 'content-type': 'application/json' };

beforeAll(async () => {
  await clearDatabase();
  await seedUser('ocr-analyst-id', {
    email: 'ocr-analyst@test.com', role: 'analyst', workspaceId: WORKSPACE,
  });
  await seedProject(PROJECT, { name: 'Captured work', workspaceId: WORKSPACE });
});

afterAll(async () => {
  await clearDatabase();
});

describe('#96 — the OCR report types are refused, not fabricated', () => {
  test.each(['ui_state_changes', 'text_entry_tracking'])(
    '%s answers 501 rather than inventing findings',
    async (reportType) => {
      const res = await request(app).post('/admin/reports/generate').set(ANALYST)
        .send({ projectId: PROJECT, reportType });

      expect(res.status).toBe(501);
      expect(res.body.reportId).toBeUndefined();
      // The operator has to be able to tell this from a failure of their own.
      expect(res.body.error).toMatch(/not (yet )?(implemented|available)/i);
    }
  );

  // The point of checking before the write, as in #105: a refused report must
  // not leave a row behind describing work that will never be done.
  test('no report row is created for either type', async () => {
    const reports = await db.collection(collections.REPORTS)
      .where('projectId', '==', PROJECT).get();

    expect(reports.size).toBe(0);
  });

  // The guard must be narrow. The report type that does read real data — #8's
  // aggregation — has to keep working exactly as before.
  test('project_progress still queues normally', async () => {
    const res = await request(app).post('/admin/reports/generate').set(ANALYST)
      .send({ projectId: PROJECT, reportType: 'project_progress' });

    expect(res.status).toBe(202);
    expect(res.body.reportId).toBeTruthy();

    await db.collection(collections.REPORTS).doc(res.body.reportId).delete();
  });

  // The refusal is about the report type, not the caller: it must not mask the
  // Workspace check that runs before it, or a foreign Project would learn that
  // it exists (#99, lesson 67).
  test('a foreign Project is refused as foreign, not as unimplemented', async () => {
    await seedProject('ocr-foreign-project', { name: 'Not yours', workspaceId: 'another-workspace' });

    const res = await request(app).post('/admin/reports/generate').set(ANALYST)
      .send({ projectId: 'ocr-foreign-project', reportType: 'ui_state_changes' });

    expect(res.status).toBe(403);
  });
});
