'use strict';
/**
 * Audits (and optionally repairs) production `users` documents that carry no
 * `workspaceId`.
 *
 * Background: before commit 5a2f414, POST /admin/users never stamped a
 * workspaceId. isInCallersWorkspace() treats a record with no workspaceId as
 * foreign to everyone — deliberately — so those users are now refused by every
 * route in backend/src/routes/admin/users.js.
 *
 * A user's Workspace is inferred from their project memberships:
 *   project_memberships.userId -> projects.workspaceId
 *
 * Only users whose memberships all point at exactly ONE Workspace are
 * repairable. Users with no memberships, or memberships spanning two
 * Workspaces, are reported and left alone: guessing would re-open the hole
 * these checks close.
 *
 * Run from `backend/`, with credentials for the live project. `firebase-admin`
 * resolves from backend/node_modules, and gcloud is unusable on the current dev
 * machine, so point GOOGLE_APPLICATION_CREDENTIALS at a service-account JSON
 * rather than relying on ADC:
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/workspace-id-audit.js
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/workspace-id-audit.js --apply
 *
 * Exit codes: 0 nothing to repair, 1 something needs a human, 2 it could not run.
 */

const fs   = require('fs');
const path = require('path');

const { initializeApp, applicationDefault, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const APPLY   = process.argv.includes('--apply');
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'thehammer';
const REPORT  = process.env.AUDIT_REPORT || path.join(__dirname, 'workspace-id-audit.json');

// This script exists to inspect PRODUCTION. Pointing it at the emulator would
// audit an empty database and report a clean bill of health, which is the one
// wrong answer that looks like success.
if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is set. Unset it: this audit must run against production.');
  process.exit(2);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at the service-account JSON.');
  process.exit(2);
}

if (getApps().length === 0) {
  initializeApp({ credential: applicationDefault(), projectId: PROJECT });
}
const db = getFirestore(process.env.DATABASE_ID || '(default)');

async function main() {
  console.log(`project: ${PROJECT}   mode: ${APPLY ? 'APPLY' : 'audit (read-only)'}\n`);

  const usersSnap = await db.collection('users').get();
  const missing   = usersSnap.docs.filter((d) => !d.data().workspaceId);

  console.log(`users total:             ${usersSnap.size}`);
  console.log(`users with no workspace: ${missing.length}\n`);

  if (missing.length === 0) {
    fs.writeFileSync(REPORT, JSON.stringify({ project: PROJECT, checkedAt: new Date().toISOString(), total: usersSnap.size, missing: [] }, null, 2));
    console.log('Nothing to repair. Every user carries a workspaceId.');
    return 0;
  }

  // Cache projects once rather than re-reading per membership.
  const projectsSnap = await db.collection('projects').get();
  const projectWorkspace = new Map(projectsSnap.docs.map((d) => [d.id, d.data().workspaceId || null]));

  const rows = [];
  for (const userDoc of missing) {
    const membSnap = await db.collection('project_memberships').where('userId', '==', userDoc.id).get();
    const workspaces = [...new Set(
      membSnap.docs.map((m) => projectWorkspace.get(m.data().projectId)).filter(Boolean),
    )];

    let verdict;
    if (workspaces.length === 1)      verdict = 'repairable';
    else if (workspaces.length === 0) verdict = 'no-memberships';
    else                              verdict = 'ambiguous';

    rows.push({
      id: userDoc.id,
      email: userDoc.data().email || null,
      role: userDoc.data().role || null,
      memberships: membSnap.size,
      candidateWorkspaces: workspaces,
      verdict,
    });
  }

  const repairable = rows.filter((r) => r.verdict === 'repairable');
  const manual     = rows.filter((r) => r.verdict !== 'repairable');

  for (const r of rows) {
    const tag = r.verdict === 'repairable' ? '→ ' + r.candidateWorkspaces[0] : '   NEEDS A DECISION';
    console.log(`  ${r.verdict.padEnd(15)} ${(r.email || r.id).padEnd(36)} ${tag}`);
  }

  console.log(`\nrepairable automatically: ${repairable.length}`);
  console.log(`need your decision:       ${manual.length}`);

  if (APPLY && repairable.length > 0) {
    console.log('\nstamping...');
    // Batched, 400 at a time, under Firestore's 500-write ceiling.
    for (let i = 0; i < repairable.length; i += 400) {
      const batch = db.batch();
      for (const r of repairable.slice(i, i + 400)) {
        batch.update(db.collection('users').doc(r.id), { workspaceId: r.candidateWorkspaces[0] });
      }
      await batch.commit();
    }
    console.log(`stamped ${repairable.length} user(s).`);
  }

  fs.writeFileSync(REPORT, JSON.stringify({
    project: PROJECT,
    checkedAt: new Date().toISOString(),
    applied: APPLY,
    total: usersSnap.size,
    missing: rows,
  }, null, 2));
  console.log(`\nreport: ${REPORT}`);

  // Exit 1 while anything still needs a human, so the wizard's gate can see it.
  return manual.length > 0 ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('\nFAILED:', err.message);
  if (String(err.message).match(/permission|PERMISSION_DENIED/i)) {
    console.error('That reads like the service account lacks Firestore access, or the key is for another project.');
  }
  process.exit(2);
});
