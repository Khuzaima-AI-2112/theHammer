/**
 * #104 — the worker routes take a projectId and a reportId on trust
 *
 * `POST /worker/reports` and `POST /worker/ocr` read both ids straight from the
 * request body. `requireWorkerAuth` accepts the internal secret *or falls back
 * to `requireAdmin`*, so before this ticket any authenticated Admin could name
 * another Customer's Project and their own report id, and have that Customer's
 * Capture counts, Session timings and Monitored User counts computed and
 * attached to an artifact they own. The report row keeps the caller's own
 * projectId — the worker writes back only `status` and `gcsPath` — so
 * `GET /admin/reports/:id/status` then answers it normally.
 *
 * Both ends are checked, because the defect mirrors: a Project the caller owns
 * writing into a foreign report is the same disclosure run backwards.
 *
 * The internal-secret path is deliberately unaffected. It carries no
 * `hammerUser` to scope against — it *is* the trusted caller — and each test
 * below says which of the two paths it exercises.
 *
 * Offline like the rest of the suite: Firestore is the `demo-hammer` emulator
 * (tests/setup/env.js), Cloud Storage and Vertex AI are mocked.
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
  text: 'Canned narrative.'
}));

process.env.GCS_BUCKET = 'fake-bucket';
process.env.INTERNAL_SECRET = 'test-internal-secret';

const request = require('supertest');
const { __saves } = require('@google-cloud/storage');
const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const collections = require('../src/lib/collections');
const { clearDatabase, seedUser, seedProject } = require('./helpers/fixtures');

const ALPHA = 'ws-alpha';
const BETA  = 'ws-beta';

// The caller: an Admin in Alpha, reaching the worker routes through the
// `requireAdmin` fallback. There is no Beta caller — nothing here asks what
// Beta can do, only what Alpha cannot reach.
const ADMIN  = { 'x-dev-user-email': 'worker-admin@test.com', 'content-type': 'application/json' };
const SECRET = { 'x-internal-secret': 'test-internal-secret', 'content-type': 'application/json' };

const ALPHA_PROJECT = 'alpha-project';
const ALPHA_REPORT  = 'alpha-report';
const BETA_PROJECT  = 'beta-project';
const BETA_REPORT   = 'beta-report';
const NONEXISTENT   = 'no-such-id-at-all';

async function seedReport(id, projectId, requester) {
  await db.collection(collections.REPORTS).doc(id).set({
    projectId,
    reportType: 'project_progress',
    dateRange: null,
    status: 'queued',
    gcsPath: null,
    requestedBy: `${requester}-requester`,
    createdAt: new Date('2026-09-01T12:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-09-01T12:00:00.000Z').toISOString(),
    schemaVersion: 1,
  });
}

/**
 * Polls a report row until `predicate` holds, or gives up and returns whatever
 * it last read. Both routes answer 202 and let the worker run on, so there is
 * no response to await for the work itself.
 */
async function waitForReport(id, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let data;
  for (;;) {
    const snap = await db.collection(collections.REPORTS).doc(id).get();
    data = snap.data();
    if (predicate(data) || Date.now() >= deadline) return data;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  await clearDatabase();

  await seedUser('worker-admin-id', {
    email: 'worker-admin@test.com', role: 'admin', workspaceId: ALPHA,
  });
  await seedProject(ALPHA_PROJECT, { name: 'Alpha work', workspaceId: ALPHA });
  await seedProject(BETA_PROJECT,  { name: 'Beta work',  workspaceId: BETA });

  await seedReport(ALPHA_REPORT, ALPHA_PROJECT, 'alpha');
  await seedReport(BETA_REPORT,  BETA_PROJECT,  'beta');

  // Beta's Capture. Its count is one of the figures computeReportMetrics()
  // would have handed to Alpha; the cases below assert it is never read.
  await db.collection(collections.UPLOADS).doc('beta-capture-1').set({
    projectId: BETA_PROJECT,
    userId: 'beta-monitored-user',
    tool: 'Softomedia',
    path: `${BETA_PROJECT}/beta-capture-1.png`,
    bucket: 'fake-bucket',
    size: 1234,
    uploadedAt: new Date('2026-09-01T10:00:00.000Z').toISOString(),
    schemaVersion: 1,
  });
});

afterEach(() => {
  __saves.length = 0;
});

afterAll(async () => {
  await clearDatabase();
});

/**
 * Nothing was computed and nothing was written: the named report row is still
 * exactly as seeded, and no object reached the bucket.
 *
 * Asserting only the 403 would pass against a route that refused the response
 * having already fired the worker — the refusal has to be proven by its
 * absence of effect, not by its status code.
 */
async function expectNoReportWasProduced(reportId) {
  const row = await waitForReport(reportId, (d) => d.status !== 'queued', 1000);
  expect(row.status).toBe('queued');
  expect(row.gcsPath).toBeNull();
  expect(__saves).toHaveLength(0);
}

describe('#104 SEC-14 — POST /worker/reports refuses a Project in another Workspace', () => {
  test('the requireAdmin path: 403, and no metrics are computed over Beta', async () => {
    const res = await request(app).post('/worker/reports').set(ADMIN)
      .send({ reportId: ALPHA_REPORT, projectId: BETA_PROJECT, reportType: 'project_progress' });

    expect(res.status).toBe(403);
    await expectNoReportWasProduced(ALPHA_REPORT);
  });

  test("Beta's Project and Captures are unchanged", async () => {
    const project = await db.collection(collections.PROJECTS).doc(BETA_PROJECT).get();
    expect(project.data().name).toBe('Beta work');
    expect(project.data().workspaceId).toBe(BETA);

    const captures = await db.collection(collections.UPLOADS)
      .where('projectId', '==', BETA_PROJECT).get();
    expect(captures.size).toBe(1);
  });
});

describe('#104 SEC-15 — POST /worker/reports refuses a report in another Workspace', () => {
  test("the requireAdmin path: 403, and Beta's report gains no result", async () => {
    const res = await request(app).post('/worker/reports').set(ADMIN)
      .send({ reportId: BETA_REPORT, projectId: ALPHA_PROJECT, reportType: 'project_progress' });

    expect(res.status).toBe(403);
    await expectNoReportWasProduced(BETA_REPORT);
  });
});

describe('#104 SEC-16 — POST /worker/ocr refuses a Project in another Workspace', () => {
  test('the requireAdmin path: 403, and nothing is written for Beta', async () => {
    const res = await request(app).post('/worker/ocr').set(ADMIN)
      .send({ reportId: ALPHA_REPORT, projectId: BETA_PROJECT, reportType: 'ui_state_changes' });

    expect(res.status).toBe(403);
    await expectNoReportWasProduced(ALPHA_REPORT);
  });
});

describe('#104 SEC-17 — POST /worker/ocr refuses a report in another Workspace', () => {
  test("the requireAdmin path: 403, and Beta's report gains no result", async () => {
    const res = await request(app).post('/worker/ocr').set(ADMIN)
      .send({ reportId: BETA_REPORT, projectId: ALPHA_PROJECT, reportType: 'ui_state_changes' });

    expect(res.status).toBe(403);
    await expectNoReportWasProduced(BETA_REPORT);
  });
});

describe('#104 SEC-18 — the refusal does not say why it is unreachable', () => {
  test('a foreign projectId and an unknown one answer alike', async () => {
    const foreign = await request(app).post('/worker/reports').set(ADMIN)
      .send({ reportId: ALPHA_REPORT, projectId: BETA_PROJECT, reportType: 'project_progress' });
    const unknown = await request(app).post('/worker/reports').set(ADMIN)
      .send({ reportId: ALPHA_REPORT, projectId: NONEXISTENT, reportType: 'project_progress' });

    expect(foreign.status).toBe(403);
    expect(unknown.status).toBe(foreign.status);
    expect(unknown.body).toEqual(foreign.body);
  });

  test('a foreign reportId and an unknown one answer alike', async () => {
    const foreign = await request(app).post('/worker/reports').set(ADMIN)
      .send({ reportId: BETA_REPORT, projectId: ALPHA_PROJECT, reportType: 'project_progress' });
    const unknown = await request(app).post('/worker/reports').set(ADMIN)
      .send({ reportId: NONEXISTENT, projectId: ALPHA_PROJECT, reportType: 'project_progress' });

    expect(foreign.status).toBe(403);
    expect(unknown.status).toBe(foreign.status);
    expect(unknown.body).toEqual(foreign.body);
  });
});

describe('#104 SEC-19 — the internal secret is unaffected', () => {
  test('the secret path: /worker/reports still runs, with no Workspace to scope to', async () => {
    const res = await request(app).post('/worker/reports').set(SECRET)
      .send({ reportId: ALPHA_REPORT, projectId: ALPHA_PROJECT, reportType: 'project_progress' });

    expect(res.status).toBe(202);

    const done = await waitForReport(ALPHA_REPORT, (d) => d.status === 'done' || d.status === 'error');
    expect(done.status).toBe('done');
    expect(done.gcsPath).toBe(`gs://fake-bucket/${ALPHA_PROJECT}/reports/${ALPHA_REPORT}.json`);
  });

  // What this test is for is the *auth* path: the internal secret is admitted
  // and reaches the worker, unaffected by the Workspace scoping #104 added.
  // The 202 and the status transition below are what prove that.
  //
  // It used to assert the report reached `done` with an artifact — but that
  // only ever passed because generateOcrReport fabricated its findings, so the
  // assertion was measuring the mock rather than the feature (#96). The worker
  // now refuses instead of inventing, and `error` is the honest outcome until
  // the real implementation lands. The secret path is no less exercised.
  test('the secret path: /worker/ocr still runs', async () => {
    const ocrReport = 'alpha-ocr-report';
    await seedReport(ocrReport, ALPHA_PROJECT, 'alpha');

    const res = await request(app).post('/worker/ocr').set(SECRET)
      .send({ reportId: ocrReport, projectId: ALPHA_PROJECT, reportType: 'ui_state_changes' });

    expect(res.status).toBe(202);

    const settled = await waitForReport(ocrReport, (d) => d.status === 'done' || d.status === 'error');
    expect(settled.status).toBe('error');
    expect(settled.gcsPath).toBeNull();
  });
});

describe("#104 — an Admin naming their own Workspace's Project is still served", () => {
  test('the requireAdmin path: Alpha naming its own Project and report is accepted', async () => {
    const ownReport = 'alpha-own-report';
    await seedReport(ownReport, ALPHA_PROJECT, 'alpha');

    const res = await request(app).post('/worker/reports').set(ADMIN)
      .send({ reportId: ownReport, projectId: ALPHA_PROJECT, reportType: 'project_progress' });

    expect(res.status).toBe(202);

    const done = await waitForReport(ownReport, (d) => d.status === 'done' || d.status === 'error');
    expect(done.status).toBe('done');
  });
});
