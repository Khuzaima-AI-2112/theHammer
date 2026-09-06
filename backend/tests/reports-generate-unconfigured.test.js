/**
 * #105 — report generation refuses to queue work nothing can pick up
 *
 * `POST /admin/reports/generate` is the only caller of the worker routes, and
 * it authenticates to them with the internal secret. When there is no secret to
 * present — production with `INTERNAL_SECRET` unset, which is exactly the
 * state #104 found deployed — the request it fires would be refused by
 * `requireWorkerAuth`. The row it had already written would then sit at
 * `queued` forever, and `GET /reports/:id/status` would report that state
 * indefinitely with nothing wrong on its face.
 *
 * So the check runs *before* the row is created, and the route answers 503.
 * A misconfigured deployment fails loudly and at the point of use, rather than
 * accumulating reports that will never be generated.
 *
 * The unconfigured state is reached here by mocking `lib/internalSecret`
 * rather than by unsetting the variable, because outside production the real
 * module generates a secret rather than resolving to nothing — that generation
 * is the behaviour `tests/internal-secret.test.js` covers, against the real
 * module. Production is the only environment where the resolution is `null`,
 * and NODE_ENV=production would disable the dev-email auth this test signs in
 * with.
 *
 * Offline like the rest of the suite: Firestore is the `demo-hammer` emulator.
 */

'use strict';

jest.mock('../src/lib/internalSecret', () => ({
  resolveInternalSecret: () => null,
}));
jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock());
jest.mock('@google/genai', () => require('./helpers/genaiMock').createGenAIMock());

process.env.GCS_BUCKET = 'fake-bucket';

const request = require('supertest');
const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const collections = require('../src/lib/collections');
const { clearDatabase, seedUser, seedProject } = require('./helpers/fixtures');

const WORKSPACE = 'unconfigured-workspace';
const PROJECT = 'unconfigured-project';
const ANALYST = { 'x-dev-user-email': 'unconfigured-analyst@test.com', 'content-type': 'application/json' };

beforeAll(async () => {
  await clearDatabase();
  await seedUser('unconfigured-analyst-id', {
    email: 'unconfigured-analyst@test.com', role: 'analyst', workspaceId: WORKSPACE,
  });
  await seedProject(PROJECT, { name: 'Work to report on', workspaceId: WORKSPACE });
});

afterAll(async () => {
  await clearDatabase();
});

describe('#105 — POST /admin/reports/generate with no internal secret to present', () => {
  test('answers 503 rather than queueing', async () => {
    const res = await request(app).post('/admin/reports/generate').set(ANALYST)
      .send({ projectId: PROJECT, reportType: 'project_progress' });

    expect(res.status).toBe(503);
    expect(res.body.reportId).toBeUndefined();
  });

  // The point of checking before the write. Without this, the route could
  // answer 503 having already filed a report no worker will ever collect.
  test('no report row is created', async () => {
    const reports = await db.collection(collections.REPORTS)
      .where('projectId', '==', PROJECT).get();

    expect(reports.size).toBe(0);
  });

  // The refusal is about configuration, not about the caller: it must not be
  // mistaken for — or mask — the Workspace check that runs just before it.
  test('a foreign Project is still refused as foreign, not as unconfigured', async () => {
    await seedProject('someone-elses-project', { name: 'Not yours', workspaceId: 'another-workspace' });

    const res = await request(app).post('/admin/reports/generate').set(ANALYST)
      .send({ projectId: 'someone-elses-project', reportType: 'project_progress' });

    expect(res.status).toBe(403);
  });
});
