'use strict';
/**
 * Gives Projects created before #62 a `lastCaptureAt`, derived from the
 * Captures they already hold.
 *
 * Background: the Projects table has a "Last capture" column and a stat tile
 * above it, both rendered from `lastCaptureAt` on the Project. Nothing ever
 * wrote that field, so both read `—` for every Project always — telling an
 * Admin deciding where to export from that a Project holds no Captures when it
 * holds four. #62 adds the stamp to the capture path, which fixes it for the
 * next Capture into each Project and for nothing that already happened. This
 * repairs the rest, and ships with the field for the same reason #102's
 * backfill did: otherwise the reported defect is still on screen, for exactly
 * the Projects with history worth reading.
 *
 * As with the write path, this times the *row*, not the image: `/upload-url`
 * writes a row before the bytes arrive and nothing reports back when they
 * land, so an Abandoned Upload dates a Project here exactly as it does live.
 * Same population `captureCount` reports (#116). See stampLastCapture in
 * backend/src/index.js for why that is the honest choice rather than a
 * narrower one.
 *
 * The value is the newest `uploadedAt` among the rows filed under the
 * Project:
 *
 *   max(uploads.where(projectId == P).uploadedAt)  ->  projects/P.lastCaptureAt
 *
 * **It never guesses.** A Project with no Captures is left with no stamp rather
 * than given a placeholder — "never captured" and "we could not tell" render
 * identically as `—`, and only one of them is true. A Capture carrying no
 * `uploadedAt` cannot date anything and is reported. A Capture naming a Project
 * that no longer exists is counted so the number is visible, and stamped
 * nowhere; #112's Purge should mean there are none, and a non-zero count here
 * is worth chasing rather than repairing (see scripts/purge-unreachable.js).
 *
 * **A Project that already carries a stamp is skipped**, never recomputed. A
 * live stamp is the write path's and is newer by construction; overwriting it
 * with a value derived from `uploads` would move the column backwards on any
 * Project whose newest Capture row was ever removed. This is a repair, not a
 * recompute — which is also what makes re-running safe after an interruption.
 *
 * **A dry run writes nothing**, and that is the default.
 *
 * Reads `uploads` and `projects` whole, unpaginated, like the backfill next
 * door. Production holds 148 objects and the largest Project has 100 Captures,
 * so one pass is cheaper than a query per Project — but this is a one-off
 * repair sized for today's data, not a job to schedule. If `uploads` ever grows
 * past what fits in memory, page it before running it again.
 *
 * Run from `backend/`, with credentials for the live project. `firebase-admin`
 * resolves from backend/node_modules, and gcloud is awkward on the current dev
 * machine, so point GOOGLE_APPLICATION_CREDENTIALS at a service-account JSON
 * rather than relying on ADC:
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/last-capture-backfill.js
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/last-capture-backfill.js --apply
 *
 * Exit codes, the same three the backfill and audit next door use: 0 nothing
 * needs a human, 1 something does, 2 it could not run.
 */

const fs = require('fs');
const path = require('path');

const PROJECTS = 'projects';
const UPLOADS = 'uploads';

/** Firestore's write ceiling is 500; batch under it. */
const BATCH_SIZE = 400;

/**
 * The newest `uploadedAt` per Project, from one pass over `uploads`.
 *
 * One pass rather than a query per Project: the alternative is an ordered query
 * per Project, which costs a round trip each and leans on the
 * (projectId, uploadedAt) composite index. `uploads` is read whole here exactly
 * once.
 *
 * Returns the newest timestamp per Project, and a count of rows that named a
 * Project but carried no usable `uploadedAt`, so the caller can report those
 * rather than silently treat them as absent.
 */
function newestCaptureByProject(snap) {
  const newest = new Map();
  let undated = 0;

  for (const doc of snap.docs) {
    const { projectId, uploadedAt } = doc.data();
    if (!projectId) continue;

    // Both upload paths write `new Date().toISOString()` — fixed-width UTC — so
    // string comparison is chronological and no parsing is needed. Anything
    // that is not such a string is counted as undated rather than coerced: a
    // row this script cannot date is a row worth a human looking at it, and
    // coercing one would let a Timestamp nothing writes pass silently.
    if (typeof uploadedAt !== 'string' || !uploadedAt) { undated += 1; continue; }

    const current = newest.get(projectId);
    if (!current || uploadedAt > current) newest.set(projectId, uploadedAt);
  }

  return { newest, undated };
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
async function backfillLastCapture({ db, apply = false } = {}) {
  const uploadsSnap = await db.collection(UPLOADS).get();
  const { newest, undated } = newestCaptureByProject(uploadsSnap);

  const projectsSnap = await db.collection(PROJECTS).get();
  const projectIds = new Set(projectsSnap.docs.map((d) => d.id));

  const report = {
    applied: !!apply,
    projects: projectsSnap.size,
    captures: uploadsSnap.size,
    skipped: 0,          // already stamped by the write path
    noCaptures: 0,       // nothing to derive from — left alone, correctly
    undated,             // Captures with no usable uploadedAt
    orphanedCaptures: 0, // Captures naming a Project that is gone
    wouldStamp: 0,
    stamped: 0,
    rows: [],
  };

  for (const projectId of newest.keys()) {
    if (!projectIds.has(projectId)) report.orphanedCaptures += 1;
  }

  const repairable = [];
  for (const doc of projectsSnap.docs) {
    if (doc.data().lastCaptureAt) { report.skipped += 1; continue; }

    const lastCaptureAt = newest.get(doc.id);
    if (!lastCaptureAt) { report.noCaptures += 1; continue; }

    repairable.push({ id: doc.id, lastCaptureAt });
  }

  report.wouldStamp = repairable.length;
  report.rows = repairable;

  if (apply && repairable.length > 0) {
    for (let i = 0; i < repairable.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (const r of repairable.slice(i, i + BATCH_SIZE)) {
        batch.update(db.collection(PROJECTS).doc(r.id), { lastCaptureAt: r.lastCaptureAt });
      }
      await batch.commit();
    }
    report.stamped = repairable.length;
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
    || path.join(__dirname, 'last-capture-backfill.json');

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

  const report = await backfillLastCapture({ db, apply: APPLY });

  console.log(`projects:           ${report.projects}`);
  console.log(`captures:           ${report.captures}`);
  console.log(`already stamped:    ${report.skipped}`);
  console.log(`no captures yet:    ${report.noCaptures}`);
  console.log(`repairable:         ${report.wouldStamp}${APPLY ? `  (stamped ${report.stamped})` : '  (dry run — nothing written)'}`);
  console.log(`undated captures:   ${report.undated}`);
  console.log(`orphaned captures:  ${report.orphanedCaptures}`);
  console.log('');

  for (const r of report.rows) {
    console.log(`  ${r.id.padEnd(24)} ${r.lastCaptureAt}`);
  }
  console.log('');

  fs.writeFileSync(REPORT, JSON.stringify({
    project: PROJECT,
    checkedAt: new Date().toISOString(),
    ...report,
  }, null, 2));
  console.log(`report: ${REPORT}`);

  if (!APPLY && report.wouldStamp > 0) {
    console.log('\nRe-run with --apply to stamp the repairable Projects.');
  }

  // Exit 1 while anything still needs a decision. A Project with no Captures
  // does not: it is correctly unstamped. Undated and orphaned Captures do —
  // both mean a Capture row nothing can account for.
  return (report.undated > 0 || report.orphanedCaptures > 0) ? 1 : 0;
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

module.exports = { backfillLastCapture };
