/**
 * #120 — a finished Report can actually be read.
 *
 * Every Report this product generates lands in Cloud Storage and stopped
 * there: `portal/app.js`'s viewer wrote a `[Mockup]` string into the panel,
 * so real metrics (#8), a real narrative (#107/#108) and an honest one (#119)
 * were all invisible in the product. This is the route that serves the
 * artifact, and the tenancy check on it — a report id must not be enough to
 * read another Customer's Report (#94's lesson, one route further along).
 *
 * Two artifact shapes, because `gcsPath` is stored two ways: the workers write
 * `gs://bucket/object`, while Storyboard finalisation and the video render
 * write a bare object path. Both are read here.
 *
 * Firestore: emulator. Cloud Storage: mocked, with a real object store behind
 * it so "the row says done but the object is gone" is a case that can be
 * tested rather than assumed.
 */
'use strict';

jest.mock('@google-cloud/storage', () => {
  const objects = new Map();
  const key = (bucket, name) => `${bucket}/${name}`;

  function MockFile(bucket, name) {
    this.name = name;
    this.exists = jest.fn(async () => [objects.has(key(bucket, name))]);
    this.download = jest.fn(async () => {
      const stored = objects.get(key(bucket, name));
      if (stored === undefined) {
        throw Object.assign(new Error('No such object'), { code: 404 });
      }
      return [Buffer.from(stored)];
    });
    this.getSignedUrl = jest.fn(async () => [
      `https://signed.test/${bucket}/${name}?X-Goog-Signature=abc`,
    ]);
    this.save = jest.fn(async (body) => { objects.set(key(bucket, name), body); });
  }

  return {
    Storage: jest.fn().mockImplementation(() => ({
      bucket: (bucketName) => ({ file: (name) => new MockFile(bucketName, name) }),
    })),
    __objects: objects,
  };
});
jest.mock('@google/genai', () => require('./helpers/genaiMock').createGenAIMock());

process.env.GCS_BUCKET = 'fake-bucket';
process.env.INTERNAL_SECRET = 'test-internal-secret';

const request = require('supertest');
const { __objects } = require('@google-cloud/storage');
const { app } = require('../src/index');
const { clearDatabase, seedUser, seedProject, seedReport } = require('./helpers/fixtures');
const { UNREACHABLE_PROJECT } = require('../src/lib/ownership');
const { parseGcsPath } = require('../src/lib/reportArtifact');

const WORKSPACE = 'artifact-workspace';
const OTHER_WORKSPACE = 'artifact-other-workspace';
const PROJECT = 'artifact-project';
const OTHER_PROJECT = 'artifact-other-project';

const ANALYST = { 'x-dev-user-email': 'artifact-analyst@test.com' };

/** The shape reportsWorker writes, narrowed to what the viewer reads. */
const ARTIFACT = {
  projectId: PROJECT,
  reportType: 'project_progress',
  generatedAt: '2026-09-08T19:06:34.727Z',
  summary: 'The project progress measurements show a total of 8 captures and 1 active user.',
  modelUsed: 'gemini-3.5-flash',
  metrics: { totalCaptures: 8, activeUsers: 1 },
  summaryGuard: { status: 'accepted' },
};

beforeAll(async () => {
  await clearDatabase();
  await seedUser('artifact-analyst-id', {
    email: 'artifact-analyst@test.com', role: 'analyst', workspaceId: WORKSPACE,
  });
  await seedProject(PROJECT, { name: 'Readable work', workspaceId: WORKSPACE });
  await seedProject(OTHER_PROJECT, { name: "Someone else's", workspaceId: OTHER_WORKSPACE });
});

beforeEach(() => { __objects.clear(); });

afterAll(async () => {
  await clearDatabase();
});

describe('where a stored gcsPath points', () => {
  test('the workers\' absolute form is split into bucket and object', () => {
    expect(parseGcsPath('gs://thehammer-storage-2026/p1/reports/r1.json', 'fallback'))
      .toEqual({ bucket: 'thehammer-storage-2026', object: 'p1/reports/r1.json' });
  });

  test('the bare object path Storyboard finalisation writes falls back to the configured bucket', () => {
    // storyboards.js:786 and shotstack.js:121 both store `${projectId}/reports/${id}.pdf`
    // with no gs:// prefix, unlike reportsWorker.js. A viewer that handled only
    // one of the two forms would work for exactly half the Reports in the product.
    expect(parseGcsPath('p1/reports/r1.pdf', 'fallback'))
      .toEqual({ bucket: 'fallback', object: 'p1/reports/r1.pdf' });
  });

  test('nothing stored points nowhere', () => {
    expect(parseGcsPath(null, 'fallback')).toBeNull();
    expect(parseGcsPath('', 'fallback')).toBeNull();
  });
});

describe('reading a finished Report', () => {
  test('a JSON artifact comes back as the artifact itself', async () => {
    __objects.set(`fake-bucket/${PROJECT}/reports/r-json.json`, JSON.stringify(ARTIFACT));
    await seedReport('r-json', {
      projectId: PROJECT, workspaceId: WORKSPACE, status: 'done',
      gcsPath: `gs://fake-bucket/${PROJECT}/reports/r-json.json`,
    });

    const res = await request(app).get('/admin/reports/r-json/artifact').set(ANALYST);

    expect(res.status).toBe(200);
    expect(res.body.contentType).toBe('application/json');
    expect(res.body.artifact.summary).toBe(ARTIFACT.summary);
    expect(res.body.artifact.metrics).toEqual({ totalCaptures: 8, activeUsers: 1 });
    // The field #119 added exists so a replaced narrative is diagnosable. It
    // has to survive the trip to the reader or it may as well not be written.
    expect(res.body.artifact.summaryGuard).toEqual({ status: 'accepted' });
    expect(res.body.reportType).toBe('project_progress');
  });

  test('a PDF artifact comes back as a signed URL, not as bytes', async () => {
    __objects.set(`fake-bucket/${PROJECT}/reports/r-pdf.pdf`, '%PDF-1.4 fake');
    await seedReport('r-pdf', {
      projectId: PROJECT, workspaceId: WORKSPACE, status: 'done',
      reportType: 'storyboard',
      gcsPath: `${PROJECT}/reports/r-pdf.pdf`,
    });

    const res = await request(app).get('/admin/reports/r-pdf/artifact').set(ANALYST);

    expect(res.status).toBe(200);
    expect(res.body.contentType).toBe('application/pdf');
    expect(res.body.url).toContain(`${PROJECT}/reports/r-pdf.pdf`);
    expect(res.body.artifact).toBeUndefined();
  });

  test('a video artifact is a signed URL too', async () => {
    __objects.set(`fake-bucket/${PROJECT}/reports/r-vid.mp4`, 'fake mp4');
    await seedReport('r-vid', {
      projectId: PROJECT, workspaceId: WORKSPACE, status: 'done',
      reportType: 'storyboard-video',
      gcsPath: `${PROJECT}/reports/r-vid.mp4`,
    });

    const res = await request(app).get('/admin/reports/r-vid/artifact').set(ANALYST);

    expect(res.status).toBe(200);
    expect(res.body.contentType).toBe('video/mp4');
    expect(res.body.url).toBeTruthy();
  });
});

describe('what the reader is told when there is nothing to show', () => {
  test('a Report still queued says so, and does not 500 on a null gcsPath', async () => {
    await seedReport('r-queued', {
      projectId: PROJECT, workspaceId: WORKSPACE, status: 'queued', gcsPath: null,
    });

    const res = await request(app).get('/admin/reports/r-queued/artifact').set(ANALYST);

    expect(res.status).toBe(409);
    expect(res.body.status).toBe('queued');
  });

  test('a Report that errored says so rather than rendering an empty panel', async () => {
    await seedReport('r-errored', {
      projectId: PROJECT, workspaceId: WORKSPACE, status: 'error', gcsPath: null,
    });

    const res = await request(app).get('/admin/reports/r-errored/artifact').set(ANALYST);

    expect(res.status).toBe(409);
    expect(res.body.status).toBe('error');
  });

  test('a done Report whose object is gone is a 404, not a crash', async () => {
    // The row is the claim; the object is the evidence. Storage Lifetime can
    // remove the second while the first stays behind.
    await seedReport('r-vanished', {
      projectId: PROJECT, workspaceId: WORKSPACE, status: 'done',
      gcsPath: `gs://fake-bucket/${PROJECT}/reports/r-vanished.json`,
    });

    const res = await request(app).get('/admin/reports/r-vanished/artifact').set(ANALYST);

    expect(res.status).toBe(404);
  });

  test('a report id that does not exist is a 404', async () => {
    const res = await request(app).get('/admin/reports/r-nope/artifact').set(ANALYST);
    expect(res.status).toBe(404);
  });
});

describe('the tenancy check', () => {
  test("another Customer's Report is refused, and refused identically to a missing one", async () => {
    __objects.set(`fake-bucket/${OTHER_PROJECT}/reports/r-foreign.json`, JSON.stringify(ARTIFACT));
    await seedReport('r-foreign', {
      projectId: OTHER_PROJECT, workspaceId: OTHER_WORKSPACE, status: 'done',
      gcsPath: `gs://fake-bucket/${OTHER_PROJECT}/reports/r-foreign.json`,
    });

    const res = await request(app).get('/admin/reports/r-foreign/artifact').set(ANALYST);

    expect(res.status).toBe(UNREACHABLE_PROJECT.status);
    expect(res.body.error).toBe(UNREACHABLE_PROJECT.error);
    // Nothing about the Report leaks alongside the refusal.
    expect(res.text).not.toContain(ARTIFACT.summary);
  });

  test('a Report whose row carries no projectId is refused, not served', async () => {
    // `loadOwnedProject` refuses a falsy projectId rather than letting
    // Firestore throw on doc(undefined) — a report row like this reaches it.
    await seedReport('r-orphan', {
      projectId: null, workspaceId: WORKSPACE, status: 'done',
      gcsPath: 'gs://fake-bucket/orphan.json',
    });

    const res = await request(app).get('/admin/reports/r-orphan/artifact').set(ANALYST);

    expect(res.status).toBe(UNREACHABLE_PROJECT.status);
  });
});
