/**
 * What a Capture looks like once it has been taken — the 2026-08-31 report:
 * three Captures produced six rows, and every row showed an em dash for TOOL,
 * PATH and SIZE.
 *
 * This drives the *primary* upload path with the exact body
 * extension/service-worker.js sends (uploadBlobWithSignedUrl), then reads the
 * two things a person actually looks at: the Activity view and the ZIP export.
 *
 * Every other test seeds the `uploads` collection by hand. That is the gap this
 * file closes: nothing had ever asserted that what /upload-url WRITES is what
 * the Activity view and the export can READ.
 *
 * Firestore: emulator. Cloud Storage: mocked — no network.
 */
'use strict';

const request = require('supertest');

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock({
  signedUrlPrefix: 'https://storage.googleapis.com/fake-bucket/'
}));

process.env.GCS_BUCKET = 'fake-bucket';

const { app, resumableObjectPath } = require('../src/index');
const { clearDatabase, seedUser, seedProject } = require('./helpers/fixtures');

const OPERATOR = { 'x-dev-user-email': 'loop-operator@test.com' };
const USER_ID  = 'loop-operator-id';
const PROJECT  = 'loop-persona-buyer';
const FALLBACK = 'loop-persona-fallback';

/** Exactly the body uploadBlobWithSignedUrl() builds, for one Capture. */
function extensionBody(project = PROJECT) {
  return {
    project,
    tool:             'Softomedia',
    stage:            'media-buyer',
    tabUrl:           'https://softomedia.example/campaigns',
    size:             34567,
    isFirstInSession: false,
    sessionStart:     null,
    sessionId:        null
  };
}

/** One Capture down the primary path, as the extension takes it. */
async function takeCapture(project = PROJECT) {
  const res = await request(app).post('/upload-url').set(OPERATOR).send(extensionBody(project));
  if (res.status !== 200) {
    throw new Error(`/upload-url answered ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

const activityFor = (project) =>
  request(app).get(`/admin/projects/${project}/activity`).set(OPERATOR);

beforeAll(async () => {
  await clearDatabase();
  // One operator who both captures and reads the portal, as Ahmed does.
  await seedUser(USER_ID, { email: 'loop-operator@test.com', role: 'admin' });
  await seedProject(PROJECT, { name: 'Persona — Media Buyer' });
  await seedProject(FALLBACK, { name: 'Persona — Fallback' });
});

afterAll(async () => {
  await clearDatabase();
});

describe('three Captures, as taken and as seen', () => {
  let activity;
  let paths;

  beforeAll(async () => {
    paths = [];
    for (let i = 0; i < 3; i++) {
      const body = await takeCapture();
      paths.push(body.path);
      // Distinct timestamps, so ordering is not the variable under test.
      await new Promise((r) => setTimeout(r, 15));
    }

    const res = await activityFor(PROJECT);
    expect(res.status).toBe(200);
    activity = res.body;
  });

  test('three Captures are three rows, not six', () => {
    expect(activity.uploads).toHaveLength(3);
  });

  test('every row carries its TOOL', () => {
    expect(activity.uploads.map((u) => u.tool)).toEqual(
      ['Softomedia', 'Softomedia', 'Softomedia']
    );
  });

  test('every row carries its PATH', () => {
    for (const u of activity.uploads) {
      expect(typeof u.gcsPath).toBe('string');
      expect(u.gcsPath).not.toHaveLength(0);
    }
  });

  test('every row carries its SIZE', () => {
    for (const u of activity.uploads) {
      expect(u.fileSizeBytes).toBe(34567);
    }
  });

  test('the PATH shown is the path the upload actually returned', () => {
    expect(activity.uploads.map((u) => u.gcsPath).sort()).toEqual([...paths].sort());
  });

  test('the export finds every object it was told about', async () => {
    const res = await request(app)
      .get(`/admin/projects/${PROJECT}/export`)
      .set(OPERATOR)
      .buffer()
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(Buffer.from(c)));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.body.length).toBeGreaterThan(0);
  });
});

/**
 * The fallback. /upload-url answers, the extension's PUT to the bucket fails,
 * and it proxies the same Capture through /capture. That is one Capture, so it
 * must stay one row — and the row must point at the bytes that actually landed.
 */
describe('a Capture whose PUT failed and fell back to the proxy', () => {
  let recorded;

  beforeAll(async () => {
    recorded = await takeCapture(FALLBACK);   // primary path records it
    await request(app)                        // PUT fails; proxy carries the path
      .post('/capture')
      .set(OPERATOR)
      .field('projectId', FALLBACK)
      .field('tool', 'Softomedia')
      .field('stage', 'media-buyer')
      .field('resumePath', recorded.path)
      .attach('file', Buffer.from('not-really-a-png'), 'shot.png')
      .expect(200);
  });

  test('is one row, not two', async () => {
    const res = await activityFor(FALLBACK);
    expect(res.body.uploads).toHaveLength(1);
  });

  test('keeps the path the Capture was recorded under', async () => {
    const res = await activityFor(FALLBACK);
    expect(res.body.uploads[0].gcsPath).toBe(recorded.path);
  });

  test('carries the real byte count, not the declared one', async () => {
    const res = await activityFor(FALLBACK);
    expect(res.body.uploads[0].fileSizeBytes).toBe(16);   // 'not-really-a-png'
  });
});

/**
 * The resumed path arrives from the client, so it is honoured only where that
 * client could already write. A rejected path is not an error — the Capture is
 * still recorded, under a fresh path (rule 4: never lose one).
 */
describe('resumableObjectPath', () => {
  const good = `${PROJECT}/${USER_ID}/2026-08-31T04-46-04-889Z_Softomedia_657d.png`;

  test('accepts the shape buildObjectPath emits, under the caller\'s own prefix', () => {
    expect(resumableObjectPath(good, PROJECT, USER_ID)).toBe(good);
  });

  test('accepts a Capture taken with no tool', () => {
    const noTool = `${PROJECT}/${USER_ID}/2026-08-31T04-46-04-889Z_657d.png`;
    expect(resumableObjectPath(noTool, PROJECT, USER_ID)).toBe(noTool);
  });

  test.each([
    ['another user\'s Capture',   `${PROJECT}/someone-else/2026-08-31T04-46-04-889Z_657d.png`],
    ['another Project',           `other-project/${USER_ID}/2026-08-31T04-46-04-889Z_657d.png`],
    ['a traversal',               `${PROJECT}/${USER_ID}/../../etc/2026-08-31T04-46-04-889Z_657d.png`],
    ['a name it did not build',   `${PROJECT}/${USER_ID}/anything-at-all.png`],
    ['a non-PNG',                 `${PROJECT}/${USER_ID}/2026-08-31T04-46-04-889Z_657d.json`],
    ['no path at all',            undefined]
  ])('rejects %s', (_label, candidate) => {
    expect(resumableObjectPath(candidate, PROJECT, USER_ID)).toBeNull();
  });
});
