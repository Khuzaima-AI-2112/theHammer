/**
 * #117 — the sweep that clears what deletions before the Purge left behind
 *
 * Production holds 17 records naming Projects that no longer exist, across five
 * dead Projects, and 26 objects under their prefixes. None of it is reachable
 * by any read path — every read resolves a Capture through its Project — so it
 * is storage nobody can address, list, export or report on (#109).
 *
 * **Tested at the module boundary**, the shape `workspace-backfill.test.js`
 * established: the script exports its work as a function taking a `db` and a
 * bucket, and these call it directly against the emulator. Driving the
 * command-line wrapper through a subprocess would test the wrapper — the
 * argument parsing, the credential guard, the exit code — rather than the
 * decision the script exists to make.
 *
 * Two properties are asserted directly rather than inferred, because they are
 * what an Operator relies on before touching a live database:
 *
 *   - **a dry run writes nothing**, and dry run is the default;
 *   - **it never guesses.** A record whose Project it cannot confirm is absent
 *     is reported and left alone. This is the only irreversible script in the
 *     set: a wrong deletion here does not fail, it destroys a live Customer's
 *     Captures and the images behind them.
 *
 * Offline like the rest of the suite: Firestore is the emulator, Cloud Storage
 * is the shared double.
 */

'use strict';

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock());

const { Storage } = require('@google-cloud/storage');
const { db } = require('../src/lib/firestore');
const collections = require('../src/lib/collections');
const {
  clearDatabase, seedProject, seedCapture, seedReport,
} = require('./helpers/fixtures');
const { seedObject, listObjects, resetObjects } = require('./helpers/gcsMock');
const { purgeUnreachable } = require('../scripts/purge-unreachable');

const LIVE = 'sweep-live-project';
const DEAD = 'sweep-dead-project';
const ALSO_DEAD = 'sweep-dead-two';

let bucket;

beforeAll(() => {
  bucket = new Storage().bucket('sweep-test-bucket');
});

beforeEach(async () => {
  await clearDatabase();
  resetObjects();
  await seedProject(LIVE, { name: 'Still Here' });
});

afterAll(async () => {
  await clearDatabase();
});

/** Every row still in a collection, by id. */
async function idsIn(name) {
  const snap = await db.collection(name).get();
  return snap.docs.map((d) => d.id).sort();
}

/** A Capture and a Report filed under a Project that no longer exists. */
async function seedOrphans(projectId, prefix) {
  await seedCapture(`${prefix}-cap`, { projectId });
  await seedReport(`${prefix}-rep`, { projectId });
}

// ── What it removes ──────────────────────────────────────────────

test('records whose Project no longer exists are removed', async () => {
  await seedOrphans(DEAD, 'o1');
  await seedCapture('live-cap', { projectId: LIVE });

  await purgeUnreachable({ db, bucket, apply: true });

  expect(await idsIn(collections.UPLOADS)).toEqual(['live-cap']);
  expect(await idsIn(collections.REPORTS)).toEqual([]);
});

test('the objects under a dead Project\'s prefix are removed', async () => {
  await seedOrphans(DEAD, 'o1');
  seedObject(`${DEAD}/user/shot.png`);
  seedObject(`${DEAD}/user/shot.json`);
  seedObject(`${LIVE}/user/keep.png`);

  await purgeUnreachable({ db, bucket, apply: true });

  expect(listObjects()).toEqual([`${LIVE}/user/keep.png`]);
});

test('a live Project keeps its records and its objects', async () => {
  await seedCapture('live-cap', { projectId: LIVE });
  seedObject(`${LIVE}/user/keep.png`);

  const report = await purgeUnreachable({ db, bucket, apply: true });

  expect(await idsIn(collections.UPLOADS)).toEqual(['live-cap']);
  expect(listObjects()).toEqual([`${LIVE}/user/keep.png`]);
  expect(report.removed).toBe(0);
});

test('more than one dead Project is swept in one pass', async () => {
  await seedOrphans(DEAD, 'o1');
  await seedOrphans(ALSO_DEAD, 'o2');
  seedObject(`${DEAD}/user/a.png`);
  seedObject(`${ALSO_DEAD}/user/b.png`);

  const report = await purgeUnreachable({ db, bucket, apply: true });

  expect(await idsIn(collections.UPLOADS)).toEqual([]);
  expect(listObjects()).toEqual([]);
  expect(report.projects.map((p) => p.projectId).sort()).toEqual([DEAD, ALSO_DEAD].sort());
});

// An Abandoned Upload is a record whose image never arrived — the upload route
// writes the row before the extension sends the bytes, deliberately. Six of the
// seventeen unreachable records in production are these.
test('a record pointing at an object that never existed is removed without error', async () => {
  await seedCapture('abandoned', { projectId: DEAD });
  expect(listObjects()).toEqual([]);

  const report = await purgeUnreachable({ db, bucket, apply: true });

  expect(await idsIn(collections.UPLOADS)).toEqual([]);
  expect(report.objectsRemoved).toBe(0);
});

// ── Dry run is the default ───────────────────────────────────────

test('a dry run writes nothing and deletes nothing', async () => {
  await seedOrphans(DEAD, 'o1');
  seedObject(`${DEAD}/user/shot.png`);

  const report = await purgeUnreachable({ db, bucket, apply: false });

  expect(await idsIn(collections.UPLOADS)).toEqual(['o1-cap']);
  expect(await idsIn(collections.REPORTS)).toEqual(['o1-rep']);
  expect(listObjects()).toEqual([`${DEAD}/user/shot.png`]);
  expect(report.applied).toBe(false);
});

test('dry run is what you get when you do not ask', async () => {
  await seedOrphans(DEAD, 'o1');
  seedObject(`${DEAD}/user/shot.png`);

  const report = await purgeUnreachable({ db, bucket });

  expect(await idsIn(collections.UPLOADS)).toEqual(['o1-cap']);
  expect(listObjects()).toEqual([`${DEAD}/user/shot.png`]);
  expect(report.applied).toBe(false);
});

test('a dry run reports exactly what it would remove', async () => {
  await seedOrphans(DEAD, 'o1');
  seedObject(`${DEAD}/user/shot.png`);
  seedObject(`${DEAD}/user/shot.json`);

  const report = await purgeUnreachable({ db, bucket });

  expect(report.removed).toBe(2);
  expect(report.objectsRemoved).toBe(2);
  const dead = report.projects.find((p) => p.projectId === DEAD);
  expect(dead.records.map((r) => r.id).sort()).toEqual(['o1-cap', 'o1-rep']);
  expect(dead.objects.sort()).toEqual([`${DEAD}/user/shot.json`, `${DEAD}/user/shot.png`]);
});

test('an applied run reports the same shape as the dry run that preceded it', async () => {
  await seedOrphans(DEAD, 'o1');
  seedObject(`${DEAD}/user/shot.png`);

  const planned = await purgeUnreachable({ db, bucket });
  const done = await purgeUnreachable({ db, bucket, apply: true });

  expect(done.removed).toBe(planned.removed);
  expect(done.objectsRemoved).toBe(planned.objectsRemoved);
  expect(done.applied).toBe(true);
});

// ── It refuses to guess ──────────────────────────────────────────

test('a record naming no Project at all is left alone and reported', async () => {
  await seedCapture('no-project', { projectId: null });

  const report = await purgeUnreachable({ db, bucket, apply: true });

  expect(await idsIn(collections.UPLOADS)).toEqual(['no-project']);
  expect(report.needsHuman).toBe(1);
  expect(report.unresolved).toEqual([
    { collection: collections.UPLOADS, id: 'no-project', reason: 'no-project-id' },
  ]);
});

test('a record whose Project is absent is confirmed absent, not assumed', async () => {
  await seedCapture('live-cap', { projectId: LIVE });
  await seedCapture('dead-cap', { projectId: DEAD });

  const report = await purgeUnreachable({ db, bucket, apply: true });

  expect(await idsIn(collections.UPLOADS)).toEqual(['live-cap']);
  expect(report.needsHuman).toBe(0);
});

// A database with no Projects at all is indistinguishable from a database that
// is not the one the Operator meant — and here that reads as "every record is
// unreachable". This is the only irreversible script in the set.
test('it refuses to sweep a database holding no Projects', async () => {
  await db.collection(collections.PROJECTS).doc(LIVE).delete();
  await seedCapture('would-be-swept', { projectId: DEAD });

  const report = await purgeUnreachable({ db, bucket, apply: true });

  expect(await idsIn(collections.UPLOADS)).toEqual(['would-be-swept']);
  expect(report.refused).toBe('no-projects');
  expect(report.removed).toBe(0);
});

// ── Safe to re-run ───────────────────────────────────────────────

test('an interrupted sweep can simply be started again', async () => {
  await seedOrphans(DEAD, 'o1');
  seedObject(`${DEAD}/user/shot.png`);

  const first = await purgeUnreachable({ db, bucket, apply: true });
  const second = await purgeUnreachable({ db, bucket, apply: true });

  expect(first.removed).toBe(2);
  expect(second.removed).toBe(0);
  expect(second.objectsRemoved).toBe(0);
  expect(second.needsHuman).toBe(0);
});

test('a sweep that removed the records but not the objects finishes on the retry', async () => {
  // The state an interrupted run leaves: rows gone, prefix still populated.
  seedObject(`${DEAD}/user/stranded.png`);
  await seedCapture('pointer', { projectId: DEAD });
  await purgeUnreachable({ db, bucket, apply: true });

  // Nothing now names the dead Project, so a second run has nothing to find —
  // which is why the record is deleted after its objects, not before.
  expect(listObjects()).toEqual([]);
});
