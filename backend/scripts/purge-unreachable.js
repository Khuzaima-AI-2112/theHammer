'use strict';
/**
 * Sweeps the records and objects left behind by deletions that happened before
 * the Purge existed (#117, ADR 0015).
 *
 * Background: deleting a Project used to remove the Project document and its
 * memberships and nothing else. Every read path resolves a Capture through its
 * Project, so everything else filed under it became unreachable — not deleted,
 * not listed, not exported, not reported on, and still billed. On 2026-09-07
 * production held **17 such records across five dead Projects, and 26 objects**
 * under their prefixes: 11 images totalling 2.04 MB and 15 JSON sidecars
 * (#109). `DELETE /admin/projects/:id` now Purges, so nothing new joins this
 * pile; this clears the pile.
 *
 * The seventeen-versus-eleven gap is not loss. Six of those records are
 * **Abandoned Uploads** — the upload route writes the record before the
 * extension sends the bytes, deliberately, so a Capture that was started and
 * never finished leaves a record pointing at nothing. They are removed the same
 * way, and a prefix that matches no object is not an error.
 *
 * **Read the record on #109 before running this.** All 26 objects are listed
 * there with dates and sizes, taken before any deletion. That comment is the
 * last trace once this runs; do not regenerate it afterwards.
 *
 * **It never guesses.** A record whose Project it cannot confirm is absent is
 * reported and left alone. This is the only irreversible script in the set:
 * elsewhere a wrong answer fails, here it destroys a live Customer's Captures
 * and the images behind them.
 *
 * **Objects go before the records that name them.** The record is the only
 * thing that knows which prefix the objects are under, so deleting it first and
 * dying would strand them permanently — the same ordering rule the Purge
 * follows, seen from the other end (ADR 0015).
 *
 * **A dry run writes nothing**, and that is the default. Re-running is safe: a
 * record already removed is not found again, so an interrupted run is simply
 * repeated.
 *
 * **Known limit: prefixes are found through the records that name them.** A
 * dead Project whose records are already gone but whose objects remain is
 * invisible here. That is deliberate. Finding it would mean listing the
 * bucket's top-level prefixes and removing every one that is not a live Project
 * — which would also delete the stale Cloud Build source archives sharing this
 * bucket (#110, explicitly out of scope), and anything else a future writer
 * puts at the root. Deleting by a prefix no record vouches for is exactly the
 * guess this script refuses to make. It matches the 26 objects measured on
 * 2026-09-07; if a later audit finds objects under no record at all, that is a
 * ticket with an inventory attached, not a wider default here.
 *
 * Run from `backend/`, with credentials for the live project — the same shape
 * as the workspace backfill next door:
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/purge-unreachable.js
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/purge-unreachable.js --apply
 *
 * Exit codes: 0 nothing needs a human, 1 something does, 2 it could not run.
 * Note what 0 does *not* mean: a dry run that found a hundred removable records
 * exits 0, because nothing about them needs a decision. Read the counts.
 */

const { PURGED_COLLECTIONS, BATCH_SIZE, prefixFor } = require('../src/lib/purge');
const collections = require('../src/lib/collections');

/** Every Project that currently exists. */
async function liveProjectIds(db) {
  const snap = await db.collection(collections.PROJECTS).get();
  return new Set(snap.docs.map((d) => d.id));
}

/**
 * What to do with one record, without ever inventing a Project.
 *
 * `no-project-id` is the refusal that matters. A record naming no Project
 * cannot be confirmed unreachable — it might be a write that failed halfway, or a
 * shape nobody has looked at yet — so it is reported and left where it is.
 */
function verdictFor(data, live) {
  const projectId = data.projectId;
  if (!projectId) return { verdict: 'no-project-id', projectId: null };
  if (live.has(projectId)) return { verdict: 'live', projectId };
  return { verdict: 'unreachable', projectId };
}

/**
 * The unit of work, exported so it can be tested at this boundary against the
 * emulator. Driving the command-line wrapper through a subprocess instead would
 * test the wrapper.
 *
 * Takes `db` and `bucket` rather than resolving them, so the caller decides
 * which database and which bucket are being touched — the CLI below points at
 * production and refuses to point anywhere else; the tests point at the
 * emulator and the shared storage double.
 *
 * Returns a report; writes nothing unless `apply` is true.
 */
async function purgeUnreachable({ db, bucket, apply = false }) {
  const live = await liveProjectIds(db);

  const report = {
    applied: !!apply,
    refused: null,
    projects: [],
    removed: 0,
    objectsRemoved: 0,
    needsHuman: 0,
    unresolved: [],
  };

  // A database holding no Projects at all is indistinguishable from a database
  // that is not the one the Operator meant, and in this script that difference
  // reads as "every record is unreachable". Refuse rather than guess — the same
  // principle as `no-project-id`, applied to the whole run.
  if (live.size === 0) {
    report.refused = 'no-projects';
    return report;
  }

  // Group them by the Project they name, because the objects are removed
  // per prefix and one prefix serves every record under it.
  const byProject = new Map();

  for (const name of PURGED_COLLECTIONS) {
    const snap = await db.collection(name).get();

    for (const doc of snap.docs) {
      const { verdict, projectId } = verdictFor(doc.data(), live);

      if (verdict === 'live') continue;
      if (verdict === 'no-project-id') {
        report.needsHuman += 1;
        report.unresolved.push({ collection: name, id: doc.id, reason: 'no-project-id' });
        continue;
      }

      if (!byProject.has(projectId)) byProject.set(projectId, []);
      byProject.get(projectId).push({ collection: name, id: doc.id, ref: doc.ref });
    }
  }

  for (const [projectId, records] of byProject) {
    const prefix = prefixFor(projectId);
    const [files] = await bucket.getFiles({ prefix });
    const objects = files.map((f) => f.name);

    if (apply) {
      // Objects first: the records are the only thing that names this prefix.
      if (objects.length > 0) await bucket.deleteFiles({ prefix, force: true });

      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = db.batch();
        for (const r of records.slice(i, i + BATCH_SIZE)) batch.delete(r.ref);
        await batch.commit();
      }
    }

    report.projects.push({
      projectId,
      records: records.map(({ collection, id }) => ({ collection, id })),
      objects,
    });
    report.removed += records.length;
    report.objectsRemoved += objects.length;
  }

  return report;
}

// ─────────────────────────────────────────────────────────────────
// Command-line wrapper
// ─────────────────────────────────────────────────────────────────

async function main() {
  const APPLY   = process.argv.includes('--apply');
  const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'thehammer';
  const BUCKET  = process.env.GCS_BUCKET || 'thehammer-storage-2026';

  // This script exists to repair PRODUCTION. Pointed at the emulator it would
  // sweep an empty database and report a clean bill of health, which is the one
  // wrong answer that looks like success.
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.error('FIRESTORE_EMULATOR_HOST is set. Unset it: this sweep must run against production.');
    return 2;
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at the service-account JSON.');
    return 2;
  }

  const { initializeApp, applicationDefault, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const { Storage } = require('@google-cloud/storage');

  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: PROJECT });
  }
  const db = getFirestore(process.env.DATABASE_ID || '(default)');
  const bucket = new Storage().bucket(BUCKET);

  console.log(`project: ${PROJECT}   bucket: ${BUCKET}   mode: ${APPLY ? 'APPLY' : 'dry run (read-only)'}\n`);
  if (APPLY) {
    console.log('Read the object inventory on #109 first — it is the last trace once this runs.\n');
  }

  const report = await purgeUnreachable({ db, bucket, apply: APPLY });

  if (report.refused === 'no-projects') {
    console.error('No Projects exist in this database. Refusing to sweep: that is');
    console.error('indistinguishable from being pointed at the wrong database, and every');
    console.error('record would look unreachable.');
    return 2;
  }

  for (const p of report.projects) {
    console.log(`project ${p.projectId} (gone)`);
    for (const r of p.records) console.log(`    record  ${r.collection.padEnd(20)} ${r.id}`);
    for (const o of p.objects) console.log(`    object  ${o}`);
    console.log('');
  }

  console.log(`records ${APPLY ? 'removed' : 'to remove'}:  ${report.removed}`);
  console.log(`objects ${APPLY ? 'removed' : 'to remove'}:  ${report.objectsRemoved}`);
  console.log(`needs human:        ${report.needsHuman}`);
  for (const u of report.unresolved) {
    console.log(`    ${u.reason.padEnd(18)} ${u.collection}/${u.id}`);
  }

  if (!APPLY && report.removed > 0) {
    console.log('\nRe-run with --apply to remove them.');
  }

  // Exit 1 while anything still needs a decision, so a gate can see it.
  return report.needsHuman > 0 ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error('\nFAILED:', err.message);
    if (String(err.message).match(/permission|PERMISSION_DENIED/i)) {
      console.error('That reads like the service account lacks Firestore or Storage access.');
    }
    process.exit(2);
  });
}

module.exports = { purgeUnreachable };
