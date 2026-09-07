/**
 * #102 — the backfill that makes pre-ADR-0014 Captures countable again
 *
 * `uploads` gained a denormalised `workspaceId` stamped at write time. Every
 * Capture written before that carries nothing, and an absent `workspaceId` means
 * the record belongs to nobody (lesson 67) — so those Captures exist in Cloud
 * Storage and in Firestore and are counted by no Dashboard at all. This script
 * resolves each one's Workspace through its Project and stamps it.
 *
 * **Tested at the module boundary**, which is the one new seam here. The script
 * exports its work as a function taking a `db`, and these tests call it directly
 * against the `demo-hammer` emulator. Driving the command-line wrapper through a
 * subprocess would test the wrapper — the argument parsing, the credential
 * guard, the exit code — rather than the decision the script exists to make.
 * (The wrapper's own production guard lives inside `main()` for exactly this
 * reason: requiring the module here must not trip it.)
 *
 * Two properties are asserted directly rather than inferred, because they are
 * the ones an operator relies on before touching a live database:
 *
 *   - **a dry run writes nothing**, and dry run is the default;
 *   - **it never guesses.** A record it cannot resolve is reported and left
 *     alone. A wrong stamp here does not merely fail — it hands one Customer's
 *     Admin a record belonging to another.
 *
 * Legacy rows are seeded in both shapes they really take: the field explicitly
 * `null`, and the field absent altogether. Firestore treats those differently in
 * a query — a document missing a field is not matched by any filter on it — so a
 * backfill that found only one shape would leave the other invisible for good.
 *
 * Offline like the rest of the suite: Firestore is the emulator.
 */

'use strict';

const { db } = require('../src/lib/firestore');
const collections = require('../src/lib/collections');
const { clearDatabase, seedProject, seedCapture } = require('./helpers/fixtures');
const { backfillWorkspaceIds } = require('../scripts/workspace-stamp-backfill');

const ALPHA = 'ws-backfill-alpha';

/** A Capture written before the field existed: no `workspaceId` key at all. */
async function seedUnstampedCapture(id, projectId) {
  await seedCapture(id, { projectId });
  const { FieldValue } = require('@google-cloud/firestore');
  await db.collection(collections.UPLOADS).doc(id).update({
    workspaceId: FieldValue.delete(),
  });
}

async function workspaceOf(id) {
  const snap = await db.collection(collections.UPLOADS).doc(id).get();
  return snap.data().workspaceId;
}

beforeEach(async () => {
  await clearDatabase();

  await seedProject('bf-project', { workspaceId: ALPHA });
  // A Project that carries no Workspace of its own, so it can resolve nothing.
  await seedProject('bf-project-unstamped', {});
  await db.collection(collections.PROJECTS).doc('bf-project-unstamped').update({ workspaceId: null });

  // Already stamped, and stamped to somewhere else, so "left alone" is
  // distinguishable from "re-stamped to the right answer by luck".
  await seedCapture('bf-already', { projectId: 'bf-project', workspaceId: 'ws-somewhere-else' });

  // The two shapes a legacy row really takes.
  await seedCapture('bf-null', { projectId: 'bf-project', workspaceId: null });
  await seedUnstampedCapture('bf-absent', 'bf-project');

  // Three the script must refuse to resolve.
  await seedCapture('bf-orphan', { projectId: 'bf-project-gone', workspaceId: null });
  await seedCapture('bf-project-unstamped', { projectId: 'bf-project-unstamped', workspaceId: null });
  await seedCapture('bf-no-project', { projectId: null, workspaceId: null });
});

afterAll(async () => {
  await clearDatabase();
});

describe('a dry run', () => {
  test('writes nothing', async () => {
    const report = await backfillWorkspaceIds({ db, collections: [collections.UPLOADS] });

    expect(report.applied).toBe(false);
    expect(report.repairable).toBe(2);          // bf-null and bf-absent
    expect(report.collections.uploads.stamped).toBe(0);

    // The database is untouched, which is the property, not the report field.
    expect(await workspaceOf('bf-null')).toBeNull();
    expect(await workspaceOf('bf-absent')).toBeUndefined();
    expect(await workspaceOf('bf-orphan')).toBeNull();
    expect(await workspaceOf('bf-already')).toBe('ws-somewhere-else');
  });

  test('is the default, so --apply is what writes', async () => {
    await backfillWorkspaceIds({ db, collections: [collections.UPLOADS] });

    expect(await workspaceOf('bf-null')).toBeNull();
  });
});

describe('applying the backfill', () => {
  test('stamps a Capture with the Workspace of its Project, in both legacy shapes', async () => {
    const report = await backfillWorkspaceIds({
      db, collections: [collections.UPLOADS], apply: true,
    });

    expect(report.applied).toBe(true);
    expect(report.collections.uploads.stamped).toBe(2);
    expect(await workspaceOf('bf-null')).toBe(ALPHA);
    expect(await workspaceOf('bf-absent')).toBe(ALPHA);
  });

  test('leaves an already-stamped Capture exactly as it was', async () => {
    await backfillWorkspaceIds({ db, collections: [collections.UPLOADS], apply: true });

    expect(await workspaceOf('bf-already')).toBe('ws-somewhere-else');
  });
});

describe('it refuses to guess', () => {
  test('a Capture whose Project is gone is left alone and reported', async () => {
    const report = await backfillWorkspaceIds({
      db, collections: [collections.UPLOADS], apply: true,
    });

    expect(await workspaceOf('bf-orphan')).toBeNull();

    const orphan = report.collections.uploads.rows.find((r) => r.id === 'bf-orphan');
    expect(orphan.verdict).toBe('orphan');
  });

  test('a Capture whose Project carries no Workspace is left alone and reported', async () => {
    const report = await backfillWorkspaceIds({
      db, collections: [collections.UPLOADS], apply: true,
    });

    expect(await workspaceOf('bf-project-unstamped')).toBeNull();

    const row = report.collections.uploads.rows.find((r) => r.id === 'bf-project-unstamped');
    expect(row.verdict).toBe('project-unstamped');
  });

  test('a Capture naming no Project at all is left alone and reported', async () => {
    const report = await backfillWorkspaceIds({
      db, collections: [collections.UPLOADS], apply: true,
    });

    expect(await workspaceOf('bf-no-project')).toBeNull();

    const row = report.collections.uploads.rows.find((r) => r.id === 'bf-no-project');
    expect(row.verdict).toBe('no-project-id');
  });

  // The count the command-line wrapper turns into exit code 1.
  test('reports that a human is needed, rather than finishing quietly', async () => {
    const report = await backfillWorkspaceIds({
      db, collections: [collections.UPLOADS], apply: true,
    });

    expect(report.needsHuman).toBe(3);
  });
});

// An interrupted run is repeated, not reconciled by hand, so the second run has
// to be a no-op over what the first one did.
test('running it twice is safe', async () => {
  await backfillWorkspaceIds({ db, collections: [collections.UPLOADS], apply: true });
  const second = await backfillWorkspaceIds({ db, collections: [collections.UPLOADS], apply: true });

  expect(second.repairable).toBe(0);
  expect(second.collections.uploads.stamped).toBe(0);
  expect(second.needsHuman).toBe(3);          // the three it still will not guess at
  expect(await workspaceOf('bf-null')).toBe(ALPHA);
  expect(await workspaceOf('bf-absent')).toBe(ALPHA);
});
