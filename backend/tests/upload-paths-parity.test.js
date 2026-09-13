/**
 * The two upload paths must record the same things.
 *
 * The extension has two ways to get a Capture to the server. It tries
 * `POST /upload-url` first — the server signs a URL and the extension PUTs the
 * image straight to Cloud Storage — and falls back to `POST /capture`, which
 * proxies the bytes through the backend, only when the first one fails.
 *
 * `/capture` writes an `uploads` document. `/upload-url` does not. Everything
 * that shows a Capture to a person reads that collection: the Activity view, the
 * ZIP export, every report. So a Capture that takes the *primary* path is in
 * storage and invisible everywhere else.
 *
 * The extension sends `stage`, `isFirstInSession`, `sessionStart` and
 * `sessionId` on both paths, with a comment saying they are "session fields for
 * backend to stamp on the uploads doc". Neither route reads any of them (#63).
 *
 * These tests are written to fail against the current backend. That is the
 * point: they state the parity the two paths are supposed to have.
 */
'use strict';

const request = require('supertest');

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock({
  signedUrlPrefix: 'https://storage.googleapis.com/fake-bucket/'
}));

process.env.GCS_BUCKET = 'fake-bucket';

const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const collections = require('../src/lib/collections');
const { clearDatabase, seedUser, seedProject } = require('./helpers/fixtures');

const H = { 'x-dev-user-email': 'parity@test.com' };

// Named rather than left to the fixtures' default, so the #102 assertions below
// read against a Workspace this file chose. A stamp that happened to match the
// fixture default would prove nothing.
const PARITY_WORKSPACE = 'ws-parity';

/** The Project the parity fixtures file Captures under. */
function parityProject() {
  return db.collection(collections.PROJECTS).doc('parity-project');
}

/** The uploads document id is the object path, percent-encoded. */
function uploadDoc(objectPath) {
  return db.collection(collections.UPLOADS).doc(encodeURIComponent(objectPath));
}

beforeAll(async () => {
  await clearDatabase();
  await seedUser('parity-user-id', { email: 'parity@test.com', role: 'user', workspaceId: PARITY_WORKSPACE });
  await seedProject('parity-project', { name: 'Parity', workspaceId: PARITY_WORKSPACE });
});

afterAll(async () => {
  await clearDatabase();
});

describe('POST /upload-url', () => {
  test('records the Capture in the uploads collection', async () => {
    const res = await request(app)
      .post('/upload-url')
      .set(H)
      .send({ project: 'parity-project', tool: 'Softomedia', stage: 'beginning' });

    expect(res.status).toBe(200);
    expect(res.body.path).toBeTruthy();

    const snap = await uploadDoc(res.body.path).get();
    expect(snap.exists).toBe(true);
  });

  test('keeps the Stage the extension sent', async () => {
    const res = await request(app)
      .post('/upload-url')
      .set(H)
      .send({ project: 'parity-project', tool: 'Softomedia', stage: 'during' });

    const snap = await uploadDoc(res.body.path).get();
    expect(snap.data()?.stage).toBe('during');
  });

  // #102: the Capture records the Workspace of the Project it is filed under.
  // Read back from Firestore rather than from the response, because the count
  // this feeds is a query over the stored row.
  test('stamps the Capture with the Project\'s Workspace', async () => {
    const res = await request(app)
      .post('/upload-url')
      .set(H)
      .send({ project: 'parity-project', tool: 'Softomedia' });

    const snap = await uploadDoc(res.body.path).get();
    expect(snap.data().workspaceId).toBe(PARITY_WORKSPACE);
  });

  // #62: the Capture also stamps its Project, so the Projects table's "Last
  // capture" column has something to read. Denormalised rather than counted
  // per request — GET /admin/projects returns up to 100 rows, and computing
  // this per row is up to 100 extra reads a page.
  test('stamps the Project with the time of the Capture', async () => {
    const before = (await parityProject().get()).data().lastCaptureAt ?? null;

    const res = await request(app)
      .post('/upload-url')
      .set(H)
      .send({ project: 'parity-project', tool: 'Softomedia' });

    const uploadedAt = (await uploadDoc(res.body.path).get()).data().uploadedAt;
    const stamped = (await parityProject().get()).data().lastCaptureAt;

    expect(stamped).toBe(uploadedAt);
    expect(stamped).not.toBe(before);
  });

  test('does not demand a tool, since /capture does not', async () => {
    // The two routes disagree today: /upload-url answers 400 without a tool and
    // /capture treats it as optional. That disagreement decides which path a
    // Capture takes, and therefore whether it is ever seen again.
    const res = await request(app)
      .post('/upload-url')
      .set(H)
      .send({ project: 'parity-project' });

    expect(res.status).toBe(200);
  });
});

describe('POST /capture', () => {
  test('keeps the Stage the extension sent', async () => {
    const res = await request(app)
      .post('/capture')
      .set(H)
      .field('projectId', 'parity-project')
      .field('tool', 'Softomedia')
      .field('stage', 'after')
      .attach('file', Buffer.from('not-really-a-png'), 'shot.png');

    expect(res.status).toBe(200);

    const snap = await uploadDoc(res.body.path).get();
    expect(snap.exists).toBe(true);
    expect(snap.data().stage).toBe('after');
  });

  // #102, and the parity this file exists to state: the fallback path stamps
  // the same Workspace as the primary one. A Capture must not become countable
  // or uncountable according to which route carried it.
  test('stamps the Capture with the Project\'s Workspace', async () => {
    const res = await request(app)
      .post('/capture')
      .set(H)
      .field('projectId', 'parity-project')
      .field('tool', 'Softomedia')
      .attach('file', Buffer.from('not-really-a-png'), 'shot.png');

    const snap = await uploadDoc(res.body.path).get();
    expect(snap.data().workspaceId).toBe(PARITY_WORKSPACE);
  });

  // #62, and the same parity argument: a Capture must not stamp its Project
  // according to which route carried it. The fallback path is the one taken
  // when the signed-URL PUT fails, so a Project whose Captures all arrived
  // that way would otherwise read as having none.
  test('stamps the Project with the time of the Capture', async () => {
    const res = await request(app)
      .post('/capture')
      .set(H)
      .field('projectId', 'parity-project')
      .field('tool', 'Softomedia')
      .attach('file', Buffer.from('not-really-a-png'), 'shot.png');

    const uploadedAt = (await uploadDoc(res.body.path).get()).data().uploadedAt;
    expect((await parityProject().get()).data().lastCaptureAt).toBe(uploadedAt);
  });
});
