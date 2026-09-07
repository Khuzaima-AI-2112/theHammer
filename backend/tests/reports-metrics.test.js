/**
 * #8 — real report aggregation
 *
 * The reports worker used to hardcode its numbers: 42 captures/hour, a
 * 12m 30s median session, 1045 total captures, 8 active users. Every one of
 * these tests exists to prove a metric came from this Project's own data.
 *
 * Firestore: emulator. Cloud Storage: mocked locally rather than through
 * helpers/gcsMock, because these tests must read back the report body that
 * was saved — the shared double creates a fresh MockFile per call, so its
 * save() jest.fn is unreachable from the test. Vertex AI: mocked.
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

const request = require('supertest');
const { __saves } = require('@google-cloud/storage');
const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const { getAIClient } = require('../src/lib/vertex');
const collections = require('../src/lib/collections');
const { clearDatabase, seedProject, seedUser, HEADERS } = require('./helpers/fixtures');
const { computeReportMetrics, formatDuration } = require('../src/lib/reportMetrics');
const { generateStandardReport } = require('../src/worker/reportsWorker');

const MIN = 60 * 1000;

async function seedUpload(id, projectId, userId, data = {}) {
  await db.collection(collections.UPLOADS).doc(id).set({
    projectId,
    userId,
    tool: 'Softomedia',
    stage: '',
    tabUrl: 'https://example.test/',
    path: `${projectId}/${id}.png`,
    bucket: 'fake-bucket',
    size: 1234,
    uploadedAt: new Date('2026-09-01T10:00:00.000Z').toISOString(),
    hasSemanticData: false,
    schemaVersion: 1,
    ...data
  });
}

async function seedSession(id, projectId, userId, startISO, durationMs, data = {}) {
  const start = new Date(startISO);
  const end = new Date(start.getTime() + durationMs);
  await db.collection(collections.SESSION_EVENTS).doc(id).set({
    sessionId: id,
    projectId,
    userId,
    sessionStart: start.toISOString(),
    sessionEnd: end.toISOString(),
    totalCaptures: 0,
    firstCapturePath: null,
    lastCapturePath: null,
    schemaVersion: 1,
    deleteAfter: null,
    flushReason: 'test',
    trueActiveMs: durationMs,
    ...data
  });
}

async function seedReport(id, projectId, reportType) {
  await db.collection(collections.REPORTS).doc(id).set({
    projectId,
    reportType,
    dateRange: null,
    status: 'queued',
    gcsPath: null,
    requestedBy: 'analyst-fixture-id',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    schemaVersion: 1
  });
}

beforeAll(async () => {
  await clearDatabase();

  // The Project under test, in one Workspace...
  await seedProject('proj-metrics', { workspaceId: 'ws-alpha' });
  // ...and a Project belonging to a different Customer entirely. Nothing it
  // owns may ever reach proj-metrics' numbers.
  await seedProject('proj-other', { workspaceId: 'ws-beta' });
  // A Project with no activity at all.
  await seedProject('proj-empty', { workspaceId: 'ws-alpha' });

  // proj-metrics: 3 Captures by 2 distinct Monitored Users.
  await seedUpload('cap-1', 'proj-metrics', 'user-a');
  await seedUpload('cap-2', 'proj-metrics', 'user-a');
  await seedUpload('cap-3', 'proj-metrics', 'user-b');

  // proj-metrics: two Sessions, 10 and 20 minutes — 30 minutes of active time.
  await seedSession('sess-1', 'proj-metrics', 'user-a', '2026-09-01T09:00:00.000Z', 10 * MIN);
  await seedSession('sess-2', 'proj-metrics', 'user-b', '2026-09-01T11:00:00.000Z', 20 * MIN);

  // An Analyst inside ws-alpha, so proj-other is another Customer's Project.
  await seedUser('analyst-fixture-id', {
    email: 'analyst-fixture@test.com',
    role: 'analyst',
    workspaceId: 'ws-alpha'
  });

  // #94: one finished report in each Workspace, so the read routes have
  // something real to hand back — or to refuse.
  await seedReport('report-mine', 'proj-metrics', 'project_progress');
  await seedReport('report-theirs', 'proj-other', 'project_progress');
  // A report whose Project has since been deleted: there is no Workspace left
  // to compare it against, so it cannot be shown to anyone.
  await seedReport('report-orphan', 'no-such-project', 'project_progress');
  // A row with no projectId at all: there is no Workspace to compare it
  // against either, and Firestore throws on doc(undefined).
  await db.collection(collections.REPORTS).doc('report-projectless').set({
    reportType: 'project_progress',
    status: 'queued',
    gcsPath: null,
    createdAt: new Date().toISOString(),
    schemaVersion: 1
  });

  // proj-other: noise that must never be counted.
  await seedUpload('other-1', 'proj-other', 'user-z');
  await seedUpload('other-2', 'proj-other', 'user-z');
  await seedSession('sess-other', 'proj-other', 'user-z', '2026-09-01T09:00:00.000Z', 90 * MIN);
});

afterAll(async () => {
  await clearDatabase();
});

describe('formatDuration', () => {
  it('renders minutes and seconds', () => {
    expect(formatDuration(12 * MIN + 30 * 1000)).toBe('12m 30s');
  });

  it('renders hours and minutes once past an hour', () => {
    expect(formatDuration(90 * MIN)).toBe('1h 30m');
  });

  it('renders seconds alone under a minute', () => {
    expect(formatDuration(45 * 1000)).toBe('45s');
  });

  it('renders zero rather than an empty string', () => {
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('computeReportMetrics — project_progress', () => {
  it('counts this Project\'s Captures and distinct Monitored Users', async () => {
    const { metrics, captureCount } = await computeReportMetrics('proj-metrics', 'project_progress');
    expect(captureCount).toBe(3);
    expect(metrics).toEqual({ totalCaptures: 3, activeUsers: 2 });
  });

  it('never counts another Workspace\'s Captures', async () => {
    const { metrics } = await computeReportMetrics('proj-other', 'project_progress');
    expect(metrics).toEqual({ totalCaptures: 2, activeUsers: 1 });
  });

  it('reports zero for a Project with no Captures', async () => {
    const { metrics, captureCount } = await computeReportMetrics('proj-empty', 'project_progress');
    expect(captureCount).toBe(0);
    expect(metrics).toEqual({ totalCaptures: 0, activeUsers: 0 });
  });
});

describe('computeReportMetrics — user_efficiency', () => {
  it('derives captures per hour from this Project\'s active Session time', async () => {
    // 3 Captures over 30 minutes of active time = 6 per hour.
    const { metrics } = await computeReportMetrics('proj-metrics', 'user_efficiency');
    expect(metrics.capturesPerHour).toBe(6);
  });

  it('takes the median Session length, not a hardcoded one', async () => {
    // Two Sessions, 10m and 20m — the median of an even count is the mean of
    // the middle two.
    const { metrics } = await computeReportMetrics('proj-metrics', 'user_efficiency');
    expect(metrics.medianSessionLength).toBe('15m 0s');
  });

  it('is null, not zero, for a Project with no Sessions', async () => {
    const { metrics } = await computeReportMetrics('proj-empty', 'user_efficiency');
    expect(metrics).toEqual({ capturesPerHour: null, medianSessionLength: null });
  });
});

describe('computeReportMetrics — executive_summary', () => {
  it('carries the full metric set, every figure computed', async () => {
    const { metrics } = await computeReportMetrics('proj-metrics', 'executive_summary');
    expect(metrics).toEqual({
      totalCaptures: 3,
      activeUsers: 2,
      capturesPerHour: 6,
      medianSessionLength: '15m 0s'
    });
  });
});

describe('computeReportMetrics — unknown report type', () => {
  it('produces no metrics rather than inventing a shape', async () => {
    const { metrics, captureCount } = await computeReportMetrics('proj-metrics', 'something_else');
    expect(metrics).toBeNull();
    expect(captureCount).toBe(3);
  });
});

describe('POST /admin/reports/generate — Workspace isolation', () => {
  // Real metrics make an unchecked projectId dangerous: the same request that
  // used to return invented numbers would now return another Customer's.
  it('accepts a Project in the Analyst\'s own Workspace', async () => {
    const res = await request(app)
      .post('/admin/reports/generate')
      .set(HEADERS.analyst)
      .send({ projectId: 'proj-metrics', reportType: 'project_progress' });
    expect(res.status).toBe(202);
  });

  it('refuses a Project belonging to another Customer', async () => {
    const res = await request(app)
      .post('/admin/reports/generate')
      .set(HEADERS.analyst)
      .send({ projectId: 'proj-other', reportType: 'project_progress' });
    expect(res.status).toBe(403);
  });

  // #103, ADR 0014: `reports` carries a denormalised workspaceId so the
  // Dashboard's pending-Reports tile can count one Customer's without an `in`
  // filter over their Project ids. This is the first of the collection's three
  // writers; the other two are in storyboard-finalize and storyboard-video,
  // asserted the same way. A fourth writer copies this test.
  it('stamps the Report with the Workspace of the Project it is generated for', async () => {
    const res = await request(app)
      .post('/admin/reports/generate')
      .set(HEADERS.analyst)
      .send({ projectId: 'proj-metrics', reportType: 'project_progress' });

    expect(res.status).toBe(202);

    const snap = await db.collection(collections.REPORTS).doc(res.body.reportId).get();
    expect(snap.data().workspaceId).toBe('ws-alpha');
  });

  // #99: refuses rather than 404s. A Project id the caller cannot reach is one
  // answer whether it is gone or somebody else's.
  it('refuses a Project that does not exist', async () => {
    const res = await request(app)
      .post('/admin/reports/generate')
      .set(HEADERS.analyst)
      .send({ projectId: 'no-such-project', reportType: 'project_progress' });
    expect(res.status).toBe(403);
  });
});

describe('GET /admin/reports/:id/status — Workspace isolation', () => {
  // #94: requireAnalyst is a role check, not a Workspace check. Before this,
  // any report id read back its status, gcsPath and reportType regardless of
  // which Customer owned it.
  it('returns the status of a report inside the calling Workspace', async () => {
    const res = await request(app)
      .get('/admin/reports/report-mine/status')
      .set(HEADERS.analyst);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('queued');
  });

  it('refuses a report whose Project belongs to another Customer', async () => {
    const res = await request(app)
      .get('/admin/reports/report-theirs/status')
      .set(HEADERS.analyst);
    expect(res.status).toBe(403);
    // The refusal must not leak what it refused.
    expect(res.body.gcsPath).toBeUndefined();
  });

  it('404s a report that does not exist', async () => {
    const res = await request(app)
      .get('/admin/reports/no-such-report/status')
      .set(HEADERS.analyst);
    expect(res.status).toBe(404);
  });

  // #99: both refuse rather than 404. A report is reachable only through a
  // Project the caller owns, so a report whose Project is gone — or which
  // carries no projectId at all — is out of reach for the same reason a
  // foreign one is, and now says so the same way.
  it('refuses a report whose Project no longer exists', async () => {
    const res = await request(app)
      .get('/admin/reports/report-orphan/status')
      .set(HEADERS.analyst);
    expect(res.status).toBe(403);
  });

  it('refuses a report carrying no projectId, rather than failing', async () => {
    const res = await request(app)
      .get('/admin/reports/report-projectless/status')
      .set(HEADERS.analyst);
    expect(res.status).toBe(403);
  });
});

describe('GET /admin/reports — Workspace isolation', () => {
  // The weaker of the two routes: it takes an arbitrary projectId, so no
  // report id has to be guessed first.
  it('lists reports for a Project inside the calling Workspace', async () => {
    const res = await request(app)
      .get('/admin/reports?projectId=proj-metrics')
      .set(HEADERS.analyst);
    expect(res.status).toBe(200);
    expect(res.body.reports.map((r) => r.id)).toContain('report-mine');
  });

  it('refuses a projectId belonging to another Customer', async () => {
    const res = await request(app)
      .get('/admin/reports?projectId=proj-other')
      .set(HEADERS.analyst);
    expect(res.status).toBe(403);
    expect(res.body.reports).toBeUndefined();
  });

  it('refuses a projectId that does not exist', async () => {
    const res = await request(app)
      .get('/admin/reports?projectId=no-such-project')
      .set(HEADERS.analyst);
    expect(res.status).toBe(403);
  });
});

describe('generateStandardReport', () => {
  beforeEach(() => {
    __saves.length = 0;
    getAIClient().models.generateContent.mockClear();
  });

  it('writes this Project\'s real numbers into the report body', async () => {
    await seedReport('rep-progress', 'proj-metrics', 'project_progress');
    await generateStandardReport('rep-progress', 'proj-metrics', 'project_progress', null);

    expect(__saves).toHaveLength(1);
    const body = JSON.parse(__saves[0].body);
    expect(body.metrics).toEqual({ totalCaptures: 3, activeUsers: 2 });
    // The numbers the worker used to invent.
    expect(body.metrics.totalCaptures).not.toBe(1045);
    expect(body.metrics.activeUsers).not.toBe(8);

    const snap = await db.collection(collections.REPORTS).doc('rep-progress').get();
    expect(snap.data().status).toBe('done');
  });

  it('builds the narrative from the computed metrics', async () => {
    await seedReport('rep-efficiency', 'proj-metrics', 'user_efficiency');
    await generateStandardReport('rep-efficiency', 'proj-metrics', 'user_efficiency', null);

    const prompt = getAIClient().models.generateContent.mock.calls[0][0].contents;
    expect(prompt).toContain('"capturesPerHour":6');
    expect(prompt).not.toContain('42');

    const body = JSON.parse(__saves[0].body);
    expect(body.summary).toBe('Canned narrative.');
  });

  it('does not ask the model to narrate a report type it has no metrics for', async () => {
    await seedReport('rep-unknown', 'proj-metrics', 'something_else');
    await generateStandardReport('rep-unknown', 'proj-metrics', 'something_else', null);

    const body = JSON.parse(__saves[0].body);
    expect(body.metrics).toBeUndefined();
    expect(body.summary).toMatch(/no metrics/i);
    expect(getAIClient().models.generateContent).not.toHaveBeenCalled();
  });

  it('says a Project has no Captures instead of narrating invented activity', async () => {
    await seedReport('rep-empty', 'proj-empty', 'project_progress');
    await generateStandardReport('rep-empty', 'proj-empty', 'project_progress', null);

    const body = JSON.parse(__saves[0].body);
    expect(body.metrics).toEqual({ totalCaptures: 0, activeUsers: 0 });
    expect(body.summary).toMatch(/no captures/i);
    // Nothing to narrate, so nothing was asked of the model.
    expect(getAIClient().models.generateContent).not.toHaveBeenCalled();

    const snap = await db.collection(collections.REPORTS).doc('rep-empty').get();
    expect(snap.data().status).toBe('done');
  });
});
