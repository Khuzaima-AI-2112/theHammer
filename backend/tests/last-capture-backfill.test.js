/**
 * #62 — the backfill that gives existing Projects a `lastCaptureAt`.
 *
 * The stamp ships with the write path, so a Project gets one the next time
 * somebody captures into it. Every Project created before that carries nothing,
 * and the portal renders nothing as `—` — which is the exact defect #62 is
 * about, still on screen, for precisely the Projects that have history worth
 * reading. So the repair ships with the field, the same way #102's did.
 *
 * The value is derivable and unambiguous: the newest `uploadedAt` among the
 * Captures already filed under the Project. Unlike the Workspace backfill next
 * door, a wrong answer here is a wrong date, not a tenancy leak — but it still
 * never guesses: a Project with no Captures is left with no stamp rather than
 * given a placeholder, because "never captured" and "we do not know" render the
 * same and only one of them is true.
 *
 * Firestore: emulator.
 */
'use strict';

const { db } = require('../src/lib/firestore');
const collections = require('../src/lib/collections');
const { clearDatabase, seedProject, seedCapture } = require('./helpers/fixtures');
const { backfillLastCapture } = require('../scripts/last-capture-backfill');

async function stampOf(projectId) {
  const snap = await db.collection(collections.PROJECTS).doc(projectId).get();
  return snap.data().lastCaptureAt;
}

beforeEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await clearDatabase();
});

test('a dry run writes nothing, and that is the default', async () => {
  await seedProject('dry-proj');
  await seedCapture('dry-cap', { projectId: 'dry-proj', uploadedAt: '2026-08-01T00:00:00.000Z' });

  const report = await backfillLastCapture({ db });

  expect(report.wouldStamp).toBe(1);
  expect(report.stamped).toBe(0);
  expect(await stampOf('dry-proj')).toBeUndefined();
});

test('--apply stamps the newest Capture the Project holds', async () => {
  await seedProject('apply-proj');
  // Seeded out of order on purpose: the answer is the newest, not the last one
  // the query happens to return.
  await seedCapture('c-mid', { projectId: 'apply-proj', uploadedAt: '2026-08-02T00:00:00.000Z' });
  await seedCapture('c-new', { projectId: 'apply-proj', uploadedAt: '2026-08-09T00:00:00.000Z' });
  await seedCapture('c-old', { projectId: 'apply-proj', uploadedAt: '2026-08-01T00:00:00.000Z' });

  const report = await backfillLastCapture({ db, apply: true });

  expect(report.stamped).toBe(1);
  expect(await stampOf('apply-proj')).toBe('2026-08-09T00:00:00.000Z');
});

test('a Project with no Captures is left unstamped, not given a placeholder', async () => {
  await seedProject('empty-proj');

  const report = await backfillLastCapture({ db, apply: true });

  expect(report.stamped).toBe(0);
  expect(report.noCaptures).toBe(1);
  expect(await stampOf('empty-proj')).toBeUndefined();
});

test('a Project that already has a stamp is skipped, so a re-run is safe', async () => {
  await seedProject('done-proj', { lastCaptureAt: '2026-08-20T00:00:00.000Z' });
  await seedCapture('done-cap', { projectId: 'done-proj', uploadedAt: '2026-08-01T00:00:00.000Z' });

  const report = await backfillLastCapture({ db, apply: true });

  expect(report.skipped).toBe(1);
  expect(report.stamped).toBe(0);
  // Emphatically not overwritten with the older derived value: a live stamp is
  // the write path's, and this script is a repair, not a recompute.
  expect(await stampOf('done-proj')).toBe('2026-08-20T00:00:00.000Z');
});

test('a Capture carrying no uploadedAt cannot date anything, and is reported', async () => {
  await seedProject('undated-proj');
  await seedCapture('undated-cap', { projectId: 'undated-proj', uploadedAt: null });

  const report = await backfillLastCapture({ db, apply: true });

  expect(report.stamped).toBe(0);
  expect(report.undated).toBe(1);
  expect(await stampOf('undated-proj')).toBeUndefined();
});

test('Captures naming a Project that is gone are counted, not stamped anywhere', async () => {
  await seedCapture('orphan-cap', { projectId: 'vanished-proj', uploadedAt: '2026-08-01T00:00:00.000Z' });

  const report = await backfillLastCapture({ db, apply: true });

  expect(report.stamped).toBe(0);
  expect(report.orphanedCaptures).toBe(1);
});
