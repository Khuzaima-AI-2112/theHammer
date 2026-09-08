/**
 * #111 — a Storyboard draft's Workspace comes from the Project, not the caller
 *
 * The companion assertion in storyboard-draft.test.js locks the property over
 * HTTP, and explains there why it cannot fail: `loadOwnedProject` admits a
 * request only when the Project's Workspace already equals the caller's, so
 * every request the rest of the suite can send makes the two candidate sources
 * produce the same value. That is lesson 67's second rule — a suite whose data
 * all sits on one side of a boundary cannot fail on that boundary — and over
 * HTTP there is no second side to stand on, because the guard is the thing that
 * forbids it.
 *
 * So this file stands on the other side at the seam instead. `loadOwnedProject`
 * is stubbed to return a Project in a Workspace that is *not* the caller's —
 * the state production reaches the moment a second Workspace exists and a
 * Project is moved, or its `workspaceId` corrected without its drafts
 * following. Against the pre-#111 code this test fails, stamping the caller's
 * `test-workspace`; that is what makes it evidence rather than decoration
 * (lesson 70: prove a check can fail before believing it passed).
 *
 * Only `loadOwnedProject` is replaced. `belongsToCaller` and the rest of
 * lib/ownership keep their real behaviour, so nothing else in the app under
 * test loses its tenancy check.
 */
'use strict';

const request = require('supertest');

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock({
  signedUrlPrefix: 'https://storage.googleapis.com/fake-bucket/'
}));

// The Workspace the Project is in. Deliberately not `test-workspace`, which is
// what seedUser gives the caller — the whole point is that the two differ. The
// `mock` prefix is Jest's rule for a variable the hoisted factory below may
// reference, and is what lets the value be named once rather than twice.
const mockProjectWorkspace = 'ws-owned-by-the-project';

jest.mock('../src/lib/ownership', () => {
  const actual = jest.requireActual('../src/lib/ownership');
  return {
    ...actual,
    loadOwnedProject: jest.fn(async () => ({
      exists: true,
      id: 'source-proj',
      data: () => ({ name: 'Source Project', workspaceId: mockProjectWorkspace }),
    })),
  };
});

process.env.GCS_BUCKET = 'fake-bucket';

const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const collections = require('../src/lib/collections');
const { clearDatabase, seedUser, HEADERS } = require('./helpers/fixtures');

beforeAll(async () => {
  await clearDatabase();
  await seedUser('analyst-fixture-id', { email: 'analyst-fixture@test.com', role: 'analyst' });
});

afterAll(async () => {
  await clearDatabase();
});

test('the draft is stamped with the Project\'s Workspace when it differs from the caller\'s', async () => {
  const res = await request(app)
    .post('/admin/projects/source-proj/storyboards')
    .set(HEADERS.analyst);
  expect(res.status).toBe(201);

  const snap = await db.collection(collections.STORYBOARD_DRAFTS).doc(res.body.id).get();
  expect(snap.data().workspaceId).toBe(mockProjectWorkspace);

  // Stated as its own assertion so a regression names the defect rather than
  // just a mismatched string: the caller's Workspace is never the source.
  expect(snap.data().workspaceId).not.toBe('test-workspace');
});
