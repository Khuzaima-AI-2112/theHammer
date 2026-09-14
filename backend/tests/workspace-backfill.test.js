/**
 * #102, #103 — the backfill that makes pre-ADR-0014 records countable again
 *
 * `uploads` and `reports` gained a denormalised `workspaceId` stamped at write
 * time. Every record written before that carries nothing, and an absent
 * `workspaceId` means the record belongs to nobody (lesson 67) — so those
 * Captures and Reports exist in Firestore and are counted by no Dashboard at
 * all. This script resolves each one's Workspace through its Project and
 * stamps it.
 *
 * #103 extended the script to a second collection rather than writing a second
 * script, so the refusal to guess, the dry-run default and the exit codes are
 * defined once. The cases below are therefore run against `reports` on the same
 * terms as `uploads`, and once against both together — because "it works on
 * each" and "it works on both in one pass" are different claims, and the second
 * is the one an operator actually runs.
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
 *     alone. A wrong stamp here does not merely fail — it hands one Workspace's
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

const { FieldValue } = require('@google-cloud/firestore');
const { db } = require('../src/lib/firestore');
const collections = require('../src/lib/collections');
const {
  clearDatabase, seedProject, seedCapture, seedReport,
} = require('./helpers/fixtures');
const {
  backfillWorkspaceIds, STAMPED_COLLECTIONS,
} = require('../scripts/workspace-stamp-backfill');

const ALPHA = 'ws-backfill-alpha';

/**
 * The two stamped collections, described the same way, so every case below is
 * stated once and run twice. A third collection added to ADR 0014's list is a
 * row here.
 */
const SUBJECTS = [
  { label: 'Captures', collection: collections.UPLOADS, seed: seedCapture, prefix: 'bf' },
  { label: 'Reports',  collection: collections.REPORTS, seed: seedReport,  prefix: 'br' },
];

async function workspaceOf(collection, id) {
  const snap = await db.collection(collection).doc(id).get();
  return snap.data().workspaceId;
}

/** A record written before the field existed: no `workspaceId` key at all. */
async function seedAbsent(subject, id, projectId) {
  await subject.seed(id, { projectId });
  await db.collection(subject.collection).doc(id).update({
    workspaceId: FieldValue.delete(),
  });
}

async function seedSubject(subject) {
  const p = subject.prefix;

  // Already stamped, and stamped to somewhere else, so "left alone" is
  // distinguishable from "re-stamped to the right answer by luck".
  await subject.seed(`${p}-already`, { projectId: 'bf-project', workspaceId: 'ws-somewhere-else' });

  // The two shapes a legacy row really takes.
  await subject.seed(`${p}-null`, { projectId: 'bf-project', workspaceId: null });
  await seedAbsent(subject, `${p}-absent`, 'bf-project');

  // Three the script must refuse to resolve.
  await subject.seed(`${p}-orphan`, { projectId: 'bf-project-gone', workspaceId: null });
  await subject.seed(`${p}-unstamped-project`, { projectId: 'bf-project-unstamped', workspaceId: null });
  await subject.seed(`${p}-no-project`, { projectId: null, workspaceId: null });
}

beforeEach(async () => {
  await clearDatabase();

  await seedProject('bf-project', { workspaceId: ALPHA });
  // A Project that carries no Workspace of its own, so it can resolve nothing.
  await seedProject('bf-project-unstamped', {});
  await db.collection(collections.PROJECTS).doc('bf-project-unstamped').update({ workspaceId: null });

  for (const subject of SUBJECTS) await seedSubject(subject);
});

afterAll(async () => {
  await clearDatabase();
});

describe.each(SUBJECTS)('$label — a dry run', (subject) => {
  const { collection, prefix } = subject;

  test('writes nothing', async () => {
    const report = await backfillWorkspaceIds({ db, collections: [collection] });

    expect(report.applied).toBe(false);
    expect(report.repairable).toBe(2);          // -null and -absent
    expect(report.collections[collection].stamped).toBe(0);

    // The database is untouched, which is the property, not the report field.
    expect(await workspaceOf(collection, `${prefix}-null`)).toBeNull();
    expect(await workspaceOf(collection, `${prefix}-absent`)).toBeUndefined();
    expect(await workspaceOf(collection, `${prefix}-orphan`)).toBeNull();
    expect(await workspaceOf(collection, `${prefix}-already`)).toBe('ws-somewhere-else');
  });

  test('is the default, so --apply is what writes', async () => {
    await backfillWorkspaceIds({ db, collections: [collection] });

    expect(await workspaceOf(collection, `${prefix}-null`)).toBeNull();
  });
});

describe.each(SUBJECTS)('$label — applying the backfill', (subject) => {
  const { collection, prefix } = subject;

  test('stamps a record with the Workspace of its Project, in both legacy shapes', async () => {
    const report = await backfillWorkspaceIds({ db, collections: [collection], apply: true });

    expect(report.applied).toBe(true);
    expect(report.collections[collection].stamped).toBe(2);
    expect(await workspaceOf(collection, `${prefix}-null`)).toBe(ALPHA);
    expect(await workspaceOf(collection, `${prefix}-absent`)).toBe(ALPHA);
  });

  test('leaves an already-stamped record exactly as it was', async () => {
    await backfillWorkspaceIds({ db, collections: [collection], apply: true });

    expect(await workspaceOf(collection, `${prefix}-already`)).toBe('ws-somewhere-else');
  });
});

describe.each(SUBJECTS)('$label — it refuses to guess', (subject) => {
  const { collection, prefix } = subject;

  async function rowFor(id) {
    const report = await backfillWorkspaceIds({ db, collections: [collection], apply: true });
    return report.collections[collection].rows.find((r) => r.id === id);
  }

  test('a record whose Project is gone is left alone and reported', async () => {
    const row = await rowFor(`${prefix}-orphan`);

    expect(await workspaceOf(collection, `${prefix}-orphan`)).toBeNull();
    expect(row.verdict).toBe('orphan');
  });

  test('a record whose Project carries no Workspace is left alone and reported', async () => {
    const row = await rowFor(`${prefix}-unstamped-project`);

    expect(await workspaceOf(collection, `${prefix}-unstamped-project`)).toBeNull();
    expect(row.verdict).toBe('project-unstamped');
  });

  test('a record naming no Project at all is left alone and reported', async () => {
    const row = await rowFor(`${prefix}-no-project`);

    expect(await workspaceOf(collection, `${prefix}-no-project`)).toBeNull();
    expect(row.verdict).toBe('no-project-id');
  });

  // The count the command-line wrapper turns into exit code 1.
  test('reports that a human is needed, rather than finishing quietly', async () => {
    const report = await backfillWorkspaceIds({ db, collections: [collection], apply: true });

    expect(report.needsHuman).toBe(3);
  });
});

// An interrupted run is repeated, not reconciled by hand, so the second run has
// to be a no-op over what the first one did.
describe.each(SUBJECTS)('$label — running it twice', (subject) => {
  const { collection, prefix } = subject;

  test('is safe', async () => {
    await backfillWorkspaceIds({ db, collections: [collection], apply: true });
    const second = await backfillWorkspaceIds({ db, collections: [collection], apply: true });

    expect(second.repairable).toBe(0);
    expect(second.collections[collection].stamped).toBe(0);
    expect(second.needsHuman).toBe(3);        // the three it still will not guess at
    expect(await workspaceOf(collection, `${prefix}-null`)).toBe(ALPHA);
    expect(await workspaceOf(collection, `${prefix}-absent`)).toBe(ALPHA);
  });
});

// What an operator actually runs: no `collections` argument at all.
describe('both collections in one pass, which is what the command line does', () => {
  test('the default list is exactly ADR 0014\'s stamped collections', () => {
    expect([...STAMPED_COLLECTIONS].sort())
      .toEqual([collections.REPORTS, collections.UPLOADS].sort());
  });

  test('stamps Captures and Reports together, and totals across both', async () => {
    const report = await backfillWorkspaceIds({ db, apply: true });

    expect(report.repairable).toBe(4);        // two in each collection
    expect(report.needsHuman).toBe(6);        // three in each

    for (const { collection, prefix } of SUBJECTS) {
      expect(report.collections[collection].stamped).toBe(2);
      expect(await workspaceOf(collection, `${prefix}-null`)).toBe(ALPHA);
      expect(await workspaceOf(collection, `${prefix}-absent`)).toBe(ALPHA);
      expect(await workspaceOf(collection, `${prefix}-orphan`)).toBeNull();
    }
  });

  test('a dry run over both writes nothing to either', async () => {
    await backfillWorkspaceIds({ db });

    for (const { collection, prefix } of SUBJECTS) {
      expect(await workspaceOf(collection, `${prefix}-null`)).toBeNull();
      expect(await workspaceOf(collection, `${prefix}-absent`)).toBeUndefined();
    }
  });
});
