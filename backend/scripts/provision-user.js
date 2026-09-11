'use strict';

/**
 * provision-user.js — add a person to a Workspace without an invitation.
 *
 * Why this exists
 * ---------------
 * The Portal offers no way to redeem an invitation *before* being provisioned.
 * `POST /workspaces/join` is deliberately open to any verified Firebase token
 * (see routes/admin/workspaces.js), but the only UI that calls it is the Join
 * box in Workspace Settings — which sits behind the auth gate that refuses an
 * unprovisioned account. So an invited person cannot reach the box they need.
 * Until that gate carries its own invite field, this script is the way in.
 *
 * It writes exactly what POST /workspaces/join would have written, so a record
 * made here is indistinguishable from one made by redeeming a token.
 *
 * Usage (run from backend/ so firebase-admin resolves):
 *
 *   export GOOGLE_APPLICATION_CREDENTIALS=/c/Users/user/.thehammer/thehammer-firebase-adminsdk-fbsvc-f7dee844c6.json
 *   node scripts/provision-user.js --email someone@example.com            # dry run
 *   node scripts/provision-user.js --email someone@example.com --apply    # write
 *
 * Options:
 *   --email <address>   required; must already have signed in once, so that a
 *                       Firebase Auth identity exists to attach the record to
 *   --role  <role>      admin | instructional_designer | user   (default: admin)
 *   --workspace <id>    defaults to the sole Workspace when there is only one
 *   --apply             actually write; without it, prints the plan and stops
 */

const admin = require('firebase-admin');
const { USER_PREFERENCES } = require('../src/lib/defaults');

const VALID_ROLES = ['admin', 'instructional_designer', 'user'];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const EMAIL = arg('email');
const ROLE = arg('role', 'admin');
const WORKSPACE = arg('workspace');
const APPLY = process.argv.includes('--apply');

if (!EMAIL) {
  console.error('Missing --email. See the header of this file for usage.');
  process.exit(1);
}
if (!VALID_ROLES.includes(ROLE)) {
  console.error(`Invalid --role "${ROLE}". One of: ${VALID_ROLES.join(', ')}`);
  process.exit(1);
}

admin.initializeApp({ projectId: 'thehammer' });
const db = admin.firestore();

(async () => {
  // 1. The Firebase Auth identity. The users document is keyed by uid, so the
  //    person must have signed in at least once — there is nothing to key on
  //    otherwise, and guessing an id would create a record nobody can reach.
  let authUser;
  try {
    authUser = await admin.auth().getUserByEmail(EMAIL);
  } catch (err) {
    console.error(`No Firebase Auth identity for ${EMAIL} (${err.code}).`);
    console.error('Ask them to open the Portal and sign in with Google once,');
    console.error('then run this again. The 403 they see is expected until then.');
    process.exit(1);
  }

  const providers = authUser.providerData.map((p) => p.providerId).join(',');
  console.log(`Auth identity: uid=${authUser.uid} providers=${providers}`);

  // 2. The Workspace. Resolved rather than assumed, so a second Workspace
  //    appearing later turns this into a prompt instead of a silent wrong write.
  let workspaceId = WORKSPACE;
  if (!workspaceId) {
    const ws = await db.collection('workspaces').get();
    if (ws.empty) {
      console.error('No workspaces exist. Create one first.');
      process.exit(1);
    }
    if (ws.size > 1) {
      console.error(`${ws.size} workspaces exist — pass --workspace <id>:`);
      ws.forEach((d) => console.error(`  ${d.id}  ${d.data().name}`));
      process.exit(1);
    }
    workspaceId = ws.docs[0].id;
    console.log(`Workspace: ${workspaceId} (${ws.docs[0].data().name}) — the only one`);
  }

  // 3. The record. Field-for-field what POST /workspaces/join writes, including
  //    preserving anything already there: this doubles as a role change.
  const ref = db.collection('users').doc(authUser.uid);
  const existing = await ref.get();
  const prior = existing.exists ? existing.data() : {};
  const now = new Date().toISOString();

  const payload = {
    email: EMAIL.toLowerCase(),
    displayName: prior.displayName ?? null,
    workspaceId,
    role: ROLE,
    createdAt: prior.createdAt ?? now,
    lastActiveAt: prior.lastActiveAt ?? now,
    updatedAt: now,
    inactivityPromptEnabled: prior.inactivityPromptEnabled ?? USER_PREFERENCES.inactivityPromptEnabled,
    inactivityTimerSeconds: prior.inactivityTimerSeconds ?? USER_PREFERENCES.inactivityTimerSeconds,
    allowPreUploadBlur: prior.allowPreUploadBlur ?? USER_PREFERENCES.allowPreUploadBlur,
    instantClipboardLinks: prior.instantClipboardLinks ?? USER_PREFERENCES.instantClipboardLinks,
    schemaVersion: prior.schemaVersion ?? 1,
  };

  console.log(`\nusers/${authUser.uid} ${existing.exists ? '(exists — will merge)' : '(new)'}`);
  console.log(JSON.stringify(payload, null, 2));

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    process.exit(0);
  }

  await ref.set(payload, { merge: true });

  const check = await ref.get();
  const w = check.data();
  console.log(`\nWritten. ${w.email} is now ${w.role} in workspace ${w.workspaceId}.`);
  console.log('They can sign in with Google immediately — no invitation needed.');
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
