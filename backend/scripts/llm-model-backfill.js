'use strict';
/**
 * Moves existing Projects off the retired `gemini-1.5-flash` (#108).
 *
 * Background: `llmModel` is persisted on every Project document, so changing
 * the defaults in `routes/admin/projects.js` leaves production Projects still
 * naming a model Vertex retired on 2025-09-24. Every AI call they make 404s,
 * and #8's graceful degradation turns that into a finished Report with no
 * narrative — the failure this ticket exists to end, still happening, for
 * exactly the Projects that have history worth narrating. So the repair ships
 * with the code change, the same way #102's and #62's did.
 *
 * **It never guesses.** Only two stored values are unambiguously wrong: a
 * retired id (lib/models.js RETIRED_MODEL_IDS), and no value at all. A Project
 * carrying some *other* unrecognised string is reported and left alone — it
 * may name a model this code has not heard of yet, and silently switching a
 * Customer's model is worse than leaving one that is already broken.
 *
 * **A dry run writes nothing**, and that is the default. Re-running is safe:
 * a Project already on a supported model is skipped, so an interrupted run is
 * simply repeated.
 *
 * Run from `backend/`, with credentials for the live project. `firebase-admin`
 * resolves from backend/node_modules, and gcloud needs CLOUDSDK_PYTHON set on
 * the current dev machine, so point GOOGLE_APPLICATION_CREDENTIALS at a
 * service-account JSON rather than relying on ADC:
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/llm-model-backfill.js
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/llm-model-backfill.js --apply
 *
 * Exit codes: 0 nothing needs a human, 1 something does, 2 it could not run —
 * the same three the two backfills next door use, so one gate reads all three.
 */

const fs   = require('fs');
const path = require('path');

const collections = require('../src/lib/collections');
const {
  DEFAULT_LLM_MODEL, RETIRED_MODEL_IDS, isSupportedLlmModel,
} = require('../src/lib/models');

// Firestore's own write limit, the same ceiling the Workspace backfill uses.
const BATCH_SIZE = 400;

/**
 * @param {object}  opts
 * @param {import('firebase-admin/firestore').Firestore} opts.db
 * @param {boolean} [opts.apply]  write the repairs; omit for a dry run
 */
async function backfillLlmModel({ db, apply = false }) {
  const snap = await db.collection(collections.PROJECTS).get();

  const report = {
    applied: !!apply,
    total: snap.size,
    skipped: 0,      // already on a supported model — nothing to do
    wouldStamp: 0,   // repairable: retired id, or none at all
    stamped: 0,      // actually written (apply only)
    needsHuman: 0,   // an unrecognised id nobody may overwrite blind
    unknown: [],
    rows: [],
  };

  for (const doc of snap.docs) {
    const current = doc.data().llmModel;

    if (isSupportedLlmModel(current)) {
      report.skipped++;
      continue;
    }

    const repairable = current === undefined || current === null || current === ''
      || RETIRED_MODEL_IDS.includes(current);

    if (!repairable) {
      report.needsHuman++;
      report.unknown.push({ id: doc.id, llmModel: current });
      continue;
    }

    report.wouldStamp++;
    report.rows.push({ id: doc.id, from: current ?? null, to: DEFAULT_LLM_MODEL });
  }

  // Only `llmModel` is written — no `updatedAt`. A backfill is not an edit
  // anybody made, and touching the timestamp would tell every reader the
  // Project changed on the day the repair ran.
  if (apply && report.rows.length > 0) {
    for (let i = 0; i < report.rows.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (const r of report.rows.slice(i, i + BATCH_SIZE)) {
        batch.update(db.collection(collections.PROJECTS).doc(r.id), { llmModel: r.to });
      }
      await batch.commit();
    }
    report.stamped = report.rows.length;
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
    || path.join(__dirname, 'llm-model-backfill.json');

  // This script exists to repair PRODUCTION. Pointed at the emulator it would
  // find an empty database and report a clean bill of health, which is the one
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

  const report = await backfillLlmModel({ db, apply: APPLY });

  console.log(`projects total:     ${report.total}`);
  console.log(`already supported:  ${report.skipped}`);
  console.log(`repairable:         ${report.wouldStamp}${APPLY ? `  (updated ${report.stamped})` : '  (dry run — nothing written)'}`);
  console.log(`needs a human:      ${report.needsHuman}`);
  console.log('');

  for (const r of report.rows) {
    console.log(`  ${r.id.padEnd(24)} ${String(r.from)} -> ${r.to}`);
  }
  for (const u of report.unknown) {
    console.log(`  ${u.id.padEnd(24)} UNRECOGNISED: ${u.llmModel} — left alone`);
  }
  console.log('');

  fs.writeFileSync(REPORT, JSON.stringify({
    project: PROJECT,
    checkedAt: new Date().toISOString(),
    ...report,
  }, null, 2));
  console.log(`report: ${REPORT}`);

  if (!APPLY && report.wouldStamp > 0) {
    console.log('\nRe-run with --apply to move the repairable Projects.');
  }

  // An unrecognised id is the only thing here a person has to decide about.
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

module.exports = { backfillLlmModel };
