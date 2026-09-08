/**
 * #22 — replaying a queued Session produces one document, not two.
 *
 * The extension now keeps a `session_events` body that could not be sent and
 * replays it on the next startup. That is only safe because this route writes
 * `doc(sessionId).set(..., { merge: true })` rather than adding a row: a body
 * sent twice is one Session, and a Session's time is never double-counted.
 *
 * That property is what the extension's queue depends on, and nothing asserted
 * it. It was true by construction and could have stopped being true — a change
 * from `doc(id).set` to `collection.add` would break the replay silently, in
 * the direction that inflates a Customer's reported hours.
 *
 * Firestore: emulator. Cloud Storage: mocked — no network.
 */
'use strict';

const request = require('supertest');

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock());

process.env.GCS_BUCKET = 'fake-bucket';

const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const collections = require('../src/lib/collections');
const { clearDatabase, seedUser, seedProject } = require('./helpers/fixtures');

const H = { 'x-dev-user-email': 'replay@test.com', 'content-type': 'application/json' };

const SESSION_ID = 'replayed-session';

/** The body the extension queues: one Session, sent more than once. */
function body(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    projectId: 'replay-project',
    sessionStart: '2026-09-02T09:00:00.000Z',
    sessionEnd: '2026-09-02T10:00:00.000Z',
    totalCaptures: 2,
    firstCapturePath: 'replay-project/a.png',
    lastCapturePath: 'replay-project/b.png',
    schemaVersion: 1,
    flushReason: 'project_changed',
    ...overrides,
  };
}

async function sessionsFor(sessionId) {
  const snap = await db.collection(collections.SESSION_EVENTS)
    .where('sessionId', '==', sessionId).get();
  return snap.docs;
}

beforeAll(async () => {
  await clearDatabase();
  await seedUser('replay-user-id', { email: 'replay@test.com', role: 'user' });
  await seedProject('replay-project', { name: 'Replay' });
});

afterAll(async () => {
  await clearDatabase();
});

test('the same Session sent twice is one document', async () => {
  const first = await request(app).post('/session-events').set(H).send(body());
  expect(first.status).toBe(200);

  const second = await request(app).post('/session-events').set(H).send(body());
  expect(second.status).toBe(200);

  const docs = await sessionsFor(SESSION_ID);
  expect(docs).toHaveLength(1);
  expect(docs[0].id).toBe(SESSION_ID);
});

test('a replay does not double-count the Session\'s captures', async () => {
  // The number an hours report is built from. Two rows, or a doubled count on
  // one row, would inflate what a Customer is told their staff did. Sends its
  // own pair rather than reading what the test above left behind, so the two
  // do not depend on running in order.
  const id = 'replayed-captures';
  await request(app).post('/session-events').set(H).send(body({ sessionId: id }));
  await request(app).post('/session-events').set(H).send(body({ sessionId: id }));

  const docs = await sessionsFor(id);
  expect(docs).toHaveLength(1);
  expect(docs[0].data().totalCaptures).toBe(2);
});

test('the last body to arrive is the one stored — a hazard, not a guarantee', async () => {
  // `merge: true` is last-write-wins on every field it carries, so this route
  // offers no protection against a *stale* body arriving after a fresher one:
  // it walks sessionEnd and totalCaptures backwards, understating the Session.
  // Asserted so the limit is written down rather than assumed away.
  //
  // Keeping the two apart is the extension's job, not this route's:
  // sessionFlush drops the queued copy the moment a live write succeeds, and
  // the drain re-reads the queue before sending each entry
  // (extension/tests/session-queue.test.js).
  const id = 'replayed-ordering';
  await request(app).post('/session-events').set(H)
    .send(body({ sessionId: id, sessionEnd: '2026-09-02T11:30:00.000Z', totalCaptures: 5 }));
  await request(app).post('/session-events').set(H)
    .send(body({ sessionId: id, sessionEnd: '2026-09-02T10:00:00.000Z', totalCaptures: 2 }));

  const docs = await sessionsFor(id);
  expect(docs).toHaveLength(1);
  expect(docs[0].data().sessionEnd).toBe('2026-09-02T10:00:00.000Z');
  expect(docs[0].data().totalCaptures).toBe(2);
});
