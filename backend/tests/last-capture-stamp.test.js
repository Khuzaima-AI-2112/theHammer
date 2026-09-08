/**
 * #62 — the Project records when its last Capture arrived, and never at the
 * cost of the Capture itself.
 *
 * The parity assertions in upload-paths-parity.test.js prove both upload routes
 * write the stamp. This file covers the half that has no route: what happens
 * when writing it fails.
 *
 * AGENTS.md rule 4 — "The Core Loop is Sacred", no new feature may block the
 * capture loop — is the whole reason `stampLastCapture` is fire-and-forget. By
 * the time it runs the Capture is already recorded in `uploads` and the object
 * is already in GCS, so the worst a failure here can cost is a stale column.
 * These tests assert it costs exactly that: the helper resolves rather than
 * rejecting, no matter what it is handed.
 *
 * Firestore: emulator. Cloud Storage: mocked — no network.
 */
'use strict';

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock());

process.env.GCS_BUCKET = 'fake-bucket';

const { stampLastCapture } = require('../src/index');
const { db } = require('../src/lib/firestore');
const collections = require('../src/lib/collections');
const { clearDatabase, seedProject } = require('./helpers/fixtures');

const WHEN = '2026-09-05T10:00:00.000Z';

const request = require('supertest');
const { app } = require('../src/index');
const { seedUser } = require('./helpers/fixtures');

beforeAll(async () => {
  await clearDatabase();
  await seedProject('stamp-proj', { name: 'Stamped' });
});

afterAll(async () => {
  await clearDatabase();
});

test('stamps the Project it is given', async () => {
  await stampLastCapture('stamp-proj', WHEN);
  const snap = await db.collection(collections.PROJECTS).doc('stamp-proj').get();
  expect(snap.data().lastCaptureAt).toBe(WHEN);
});

// The failure this is really about. `update()` on a document that does not
// exist rejects with NOT_FOUND, and an unhandled rejection here would surface
// as a crashed request on the capture path — the one path AGENTS.md rule 4
// says must never be blocked by a feature.
test('a Project that no longer exists is logged, not thrown', async () => {
  await expect(stampLastCapture('no-such-project', WHEN)).resolves.toBeUndefined();
});

// Belt and braces on the arguments, because the caller passes fields straight
// off a Capture. A missing projectId used to reach Firestore as doc(undefined),
// which throws synchronously rather than rejecting — a different failure mode
// from the one above, and one a .catch() would not have caught.
test.each([
  ['no projectId', undefined, WHEN],
  ['no timestamp', 'stamp-proj', undefined],
  ['neither', undefined, undefined],
])('%s is a no-op, not a throw', async (_label, projectId, when) => {
  await expect(stampLastCapture(projectId, when)).resolves.toBeUndefined();
});

test('a no-op leaves the existing stamp alone', async () => {
  await stampLastCapture('stamp-proj', WHEN);
  await stampLastCapture('stamp-proj', undefined);
  const snap = await db.collection(collections.PROJECTS).doc('stamp-proj').get();
  expect(snap.data().lastCaptureAt).toBe(WHEN);
});

// Pinned behaviour, not an accident, and the reason CONTEXT.md defines "Last
// capture" as when a Project was last *worked in* rather than as a Capture.
//
// /upload-url writes the `uploads` row before the extension PUTs the bytes,
// and nothing reports back when they land — so a Project whose upload failed
// still carries a stamp. By CONTEXT.md's language that row is an Abandoned
// Upload, not a Capture. It is the same population `captureCount` already
// counts (#116).
//
// Stated as a test so the next person to notice finds the decision rather than
// a bug: narrowing this to the /capture fallback would leave the primary path
// unstamped and put the '—' straight back, and confirming it against Cloud
// Storage would put a round trip on the loop AGENTS.md rule 4 protects.
test('an upload whose bytes never arrive still stamps the Project', async () => {
  await seedUser('stamp-user-id', { email: 'stamp-user@test.com', role: 'user' });
  await seedProject('abandoned-proj', { name: 'Abandoned' });

  // No PUT follows: this is exactly the shape of an upload that fails.
  const res = await request(app)
    .post('/upload-url')
    .set({ 'x-dev-user-email': 'stamp-user@test.com' })
    .send({ project: 'abandoned-proj', tool: 'Softomedia' });
  expect(res.status).toBe(200);

  const snap = await db.collection(collections.PROJECTS).doc('abandoned-proj').get();
  expect(snap.data().lastCaptureAt).toEqual(expect.any(String));
});