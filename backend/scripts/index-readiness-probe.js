'use strict';
/**
 * Asks the live project whether the composite indexes a route needs are
 * actually serving, by issuing the query shapes themselves.
 *
 * Background: three things that look like a green light are not one.
 * `npm run test:indexes` audits `firestore.indexes.json` against the repo and
 * says nothing about production. The emulator serves every query shape with no
 * index at all, so the whole local suite passes either way. And the CLI's
 * `Deploy complete!` reports that Firestore *accepted* the definition, not that
 * the index is *built* — a `Building` index behaves in every observable way
 * like an absent one: same FAILED_PRECONDITION, same status code. All three are
 * green at the exact moment the route is broken (lesson 68).
 *
 * The only check that means anything is the real query, against the real
 * project. That is this script. It was rewritten from lesson 68's prose twice
 * — once for #7 and once for #101 — before being kept.
 *
 * Adding a shape: append to SHAPES below, in the same change that adds the
 * query to a route and the index to firestore.indexes.json. A shape whose
 * filter values are made up is fine and expected; `count 0` means the index
 * served, not that anything is wrong. It is the *throw* that carries the
 * information here, never the number.
 *
 * Run from `backend/`, with credentials for the live project. `firebase-admin`
 * resolves from backend/node_modules:
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/index-readiness-probe.js
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/index-readiness-probe.js --watch
 *
 * `--watch` re-probes every 30s for up to 15 minutes, which is what a freshly
 * deployed index needs: #7's pair took about 15 seconds to build, #101's took
 * about 2.5 minutes. Neither number is a rule.
 *
 * Exit codes: 0 every shape serves, 1 something is still building or absent,
 * 2 it could not run.
 */

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const WATCH   = process.argv.includes('--watch');
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'thehammer';

const WATCH_INTERVAL_MS = 30 * 1000;
const WATCH_ATTEMPTS    = 30;

// This script exists to inspect PRODUCTION. Pointed at the emulator it would
// report every shape ready — the emulator needs no indexes — which is the one
// wrong answer that looks like success.
if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is set. Unset it: this probe must run against production.');
  console.error('The emulator serves every query without an index, so it would report a clean pass.');
  process.exit(2);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at the service-account JSON.');
  process.exit(2);
}

initializeApp({ projectId: PROJECT });
const db = getFirestore();

// Filter values are deliberately arbitrary: an index is required by the shape
// of a query, not by what it matches.
const WORKSPACE  = 'index-probe-workspace-id';
const now        = new Date();
const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

const SHAPES = [
  {
    // #101 — GET /admin/dashboard/stats, activeProjects
    name: 'projects: where(workspaceId ==).where(memberCount > 0).count()',
    run: () => db.collection('projects')
      .where('workspaceId', '==', WORKSPACE)
      .where('memberCount', '>', 0)
      .count().get(),
  },
  {
    // #101 — GET /admin/dashboard/stats, activeUsersToday
    name: 'users: where(workspaceId ==).where(lastActiveAt >= startOfDay).count()',
    run: () => db.collection('users')
      .where('workspaceId', '==', WORKSPACE)
      .where('lastActiveAt', '>=', startOfDay)
      .count().get(),
  },
  {
    // #102 — GET /admin/dashboard/stats, capturesToday
    name: 'uploads: where(workspaceId ==).where(uploadedAt >= startOfDay).count()',
    run: () => db.collection('uploads')
      .where('workspaceId', '==', WORKSPACE)
      .where('uploadedAt', '>=', startOfDay)
      .count().get(),
  },
  {
    // #7 — GET /admin/users, scoped roster
    name: 'users: where(workspaceId ==).orderBy(email asc)',
    run: () => db.collection('users')
      .where('workspaceId', '==', WORKSPACE)
      .orderBy('email', 'asc')
      .limit(1).get(),
  },
  {
    // #7 — GET /admin/users?role=, scoped roster filtered by Role
    name: 'users: where(workspaceId ==).where(role ==).orderBy(email asc)',
    run: () => db.collection('users')
      .where('workspaceId', '==', WORKSPACE)
      .where('role', '==', 'user')
      .orderBy('email', 'asc')
      .limit(1).get(),
  },
];

/** Is this the error a Building or absent index gives? */
function isMissingIndex(err) {
  return err.code === 9 || /FAILED_PRECONDITION/i.test(String(err && err.message));
}

async function probeOnce({ quiet = false } = {}) {
  const notServing = [];

  for (const shape of SHAPES) {
    try {
      const snap = await shape.run();
      const detail = typeof snap.data === 'function' ? `count ${snap.data().count}` : `${snap.size} doc(s)`;
      if (!quiet) console.log(`READY     ${shape.name}  -> ${detail}`);
    } catch (err) {
      notServing.push(shape.name);
      if (!quiet) {
        console.log(`${isMissingIndex(err) ? 'BUILDING/ABSENT' : 'ERROR   '}  ${shape.name}`);
        console.log(`          ${String(err.message).split('\n')[0]}`);
      }
      if (!isMissingIndex(err)) throw err;
    }
  }

  return notServing;
}

async function main() {
  console.log(`probing ${SHAPES.length} query shape(s) against ${PROJECT}\n`);

  let notServing = await probeOnce();

  if (notServing.length && WATCH) {
    console.log(`\nwatching — re-probing every ${WATCH_INTERVAL_MS / 1000}s\n`);
    for (let attempt = 1; attempt <= WATCH_ATTEMPTS && notServing.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
      notServing = await probeOnce({ quiet: true });
      console.log(`  attempt ${attempt}: ${SHAPES.length - notServing.length}/${SHAPES.length} serving`);
    }
    if (!notServing.length) {
      console.log('');
      await probeOnce();
    }
  }

  if (notServing.length) {
    console.log(`\n${notServing.length} shape(s) not serving:`);
    notServing.forEach((n) => console.log(`  - ${n}`));
    console.log('\nA deployed index is not yet a built one. Re-run, or pass --watch.');
    return 1;
  }

  console.log('\nEvery shape serves.');
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('\nFAILED:', err.message);
  if (String(err.message).match(/permission|PERMISSION_DENIED/i)) {
    console.error('That reads like the service account lacks Firestore access, or the key is for another project.');
  }
  process.exit(2);
});
