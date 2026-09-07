'use strict';
/**
 * Stamps `workspaceId` onto the Project-child records written before ADR 0014
 * added the field (#102, and `reports` in #103).
 *
 * Background: `uploads` and `reports` carried only a `projectId`, so counting
 * or listing them for one Customer meant an `in` filter over that Customer's
 * Project ids — capped at 30 values. ADR 0014 chose a denormalised
 * `workspaceId`, stamped at write time from the Project the caller has already
 * been proved to own. Records written before that stamp carry nothing, and an
 * absent `workspaceId` means the record belongs to *nobody* (lesson 67), never
 * to whoever asked. So an un-backfilled Capture is in Cloud Storage and in
 * Firestore and counted by no Dashboard at all — a quieter version of the bug
 * #98 fixes, which is why this ships with the field rather than after it.
 *
 * A record's Workspace is resolved through its Project:
 *   uploads.projectId -> projects.workspaceId
 *
 * **It never guesses.** A record whose Project is gone, whose Project carries no
 * Workspace of its own, or which names no Project at all is reported and left
 * alone. Here a wrong stamp is worse than no stamp: it does not merely fail, it
 * grants one Customer's Admin sight of another Customer's record.
 *
 * **A dry run writes nothing**, and that is the default. Re-running is safe:
 * already-stamped records are skipped, so an interrupted run is simply repeated.
 *
 * Run from `backend/`, with credentials for the live project. `firebase-admin`
 * resolves from backend/node_modules, and gcloud is awkward on the current dev
 * machine, so point GOOGLE_APPLICATION_CREDENTIALS at a service-account JSON
 * rather than relying on ADC:
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/workspace-stamp-backfill.js
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/workspace-stamp-backfill.js --apply
 *
 * Exit codes: 0 nothing needs a human, 1 something does, 2 it could not run —
 * the same three the workspace-id audit next door uses, so one gate reads both.
 * Note what 0 does *not* mean: a dry run that found a hundred repairable records
 * exits 0, because nothing about them needs a decision. Read the counts.
 */

const fs = require('fs');
const path = require('path');

/**
 * The collections ADR 0014 stamps, and the field each resolves its Workspace
 * through. `session_events` and `inactivity_events` are Project-children too and
 * are deliberately absent: nothing reads them across Projects, and speculative
 * schema is how a field ends up half-written.
 */
const STAMPED_COLLECTIONS = ['uploads'];

const PROJECTS = 'projects';

/** Firestore's write ceiling is 500; batch under it. */
const BATCH_SIZE = 400;

/**
 * Reads every Project once, so a collection of any size costs one pass rather
 * than a lookup per record.
 */
async function loadProjectWorkspaces(db) {
  const snap = await db.collection(PROJECTS).get();
  return new Map(snap.docs.map((d) => [d.id, d.data().workspaceId || null]));
}

/**
 * Decides what to do with one unstamped record, without ever inventing a
 * Workspace. Every branch that is not `repairable` needs a human.
 */
function verdictFor(data, projectWorkspace) {
  const projectId = data.projectId;
  if (!projectId) return { verdict: 'no-project-id', workspaceId: null };
  if (!projectWorkspace.has(projectId)) return { verdict: 'orphan', workspaceId: null };

  const workspaceId = projectWorkspace.get(projectId);
  if (!workspaceId) return { verdict: 'project-unstamped', workspaceId: null };

  return { verdict: 'repairable', workspaceId };
}

/**
 * The unit of work, exported so it can be tested at this boundary against the
 * emulator. Driving the command-line wrapper through a subprocess instead would
 * test the wrapper.
 *
 * Takes `db` rather than resolving one, so the caller decides which database is
 * being touched — the CLI below points at production and refuses to point
 * anywhere else; the tests point at the emulator.
 *
 * Returns a report; writes nothing unless `apply` is true.
 */
async function backfillWorkspaceIds({ db, collections = STAMPED_COLLECTIONS, apply = false }) {
  const projectWorkspace = await loadProjectWorkspaces(db);
  const report = { applied: !!apply, collections: {}, repairable: 0, needsHuman: 0 };

  for (const name of collections) {
    const snap = await db.collection(name).get();

    const rows = [];
    for (const doc of snap.docs) {
      const data = doc.data();
      if (data.workspaceId) continue;   // already stamped: idempotent by construction

      const { verdict, workspaceId } = verdictFor(data, projectWorkspace);
      rows.push({ id: doc.id, projectId: data.projectId || null, verdict, workspaceId });
    }

    const repairable = rows.filter((r) => r.verdict === 'repairable');
    const manual     = rows.filter((r) => r.verdict !== 'repairable');

    if (apply && repairable.length > 0) {
      for (let i = 0; i < repairable.length; i += BATCH_SIZE) {
        const batch = db.batch();
        for (const r of repairable.slice(i, i + BATCH_SIZE)) {
          batch.update(db.collection(name).doc(r.id), { workspaceId: r.workspaceId });
        }
        await batch.commit();
      }
    }

    report.collections[name] = {
      total: snap.size,
      unstamped: rows.length,
      repairable: repairable.length,
      stamped: apply ? repairable.length : 0,
      needsHuman: manual.length,
      rows,
    };
    report.repairable += repairable.length;
    report.needsHuman += manual.length;
  }

  return report;
}

// ─────────────────────────────────────────────────────────────────
// Command-line wrapper
// ─────────────────────────────────────────────────────────────────

async function main() {
  const APPLY   = process.argv.includes('--apply');
  const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'thehammer';
  const REPORT  = process.env.BACKFILL_REPORT
    || path.join(__dirname, 'workspace-stamp-backfill.json');

  // This script exists to repair PRODUCTION. Pointed at the emulator it would
  // stamp an empty database and report a clean bill of health, which is the one
  // wrong answer that looks like success.
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.error('FIRESTORE_EMULATOR_HOST is set. Unset it: this backfill must run against production.');
    return 2;
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at the service-account JSON.');
    return 2;
  }

  const { initializeApp, applicationDefault, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');

  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: PROJECT });
  }
  const db = getFirestore(process.env.DATABASE_ID || '(default)');

  console.log(`project: ${PROJECT}   mode: ${APPLY ? 'APPLY' : 'dry run (read-only)'}\n`);

  const report = await backfillWorkspaceIds({ db, apply: APPLY });

  for (const [name, c] of Object.entries(report.collections)) {
    console.log(`${name}`);
    console.log(`  total:        ${c.total}`);
    console.log(`  unstamped:    ${c.unstamped}`);
    console.log(`  repairable:   ${c.repairable}${APPLY ? `  (stamped ${c.stamped})` : '  (dry run — nothing written)'}`);
    console.log(`  needs human:  ${c.needsHuman}`);
    for (const r of c.rows.filter((x) => x.verdict !== 'repairable')) {
      console.log(`    ${r.verdict.padEnd(18)} ${r.id}   project: ${r.projectId ?? '(none)'}`);
    }
    console.log('');
  }

  fs.writeFileSync(REPORT, JSON.stringify({
    project: PROJECT,
    checkedAt: new Date().toISOString(),
    ...report,
  }, null, 2));
  console.log(`report: ${REPORT}`);

  if (!APPLY && report.repairable > 0) {
    console.log('\nRe-run with --apply to stamp the repairable records.');
  }

  // Exit 1 while anything still needs a decision, so a gate can see it.
  return report.needsHuman > 0 ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error('\nFAILED:', err.message);
    if (String(err.message).match(/permission|PERMISSION_DENIED/i)) {
      console.error('That reads like the service account lacks Firestore access, or the key is for another project.');
    }
    process.exit(2);
  });
}

module.exports = { backfillWorkspaceIds, STAMPED_COLLECTIONS };
