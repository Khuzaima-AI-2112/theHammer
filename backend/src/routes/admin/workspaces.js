'use strict';

const logger = require('../../lib/logger');


const express = require('express');
const crypto = require('crypto');
const { db } = require('../../lib/firestore');
const { requireAdmin, requireFirebaseUser } = require('../../middleware/requireAuth');
const { VALID_ROLES } = require('../../lib/roles');
const { USER_PREFERENCES } = require('../../lib/defaults');
const collections = require('../../lib/collections');

const router = express.Router();

function nowISO() { return new Date().toISOString(); }

// ─────────────────────────────────────────────────────────────────
// POST /workspaces (Create the first workspace, and its administrator)
// Auth: a verified Firebase token whose email matches BOOTSTRAP_ADMIN_EMAIL
//
// This route used to sit behind requireAuth('user'), which refuses anyone
// without a users document — that is, the newly signed-up user its own comment
// described. The collection therefore had no way to gain a first record and no
// administrator could ever exist (#33).
//
// theHammer is invite-only (ADR 0012), so this is not self-serve signup. The
// address named by BOOTSTRAP_ADMIN_EMAIL is the single exception, because the
// first administrator has nobody to be invited by. Everyone after them arrives
// through /workspaces/join.
// ─────────────────────────────────────────────────────────────────
router.post('/workspaces', requireFirebaseUser, async (req, res, next) => {
  try {
    // Read at request time, not at module load: an unset variable must deny,
    // and setting it on the service must take effect without a code change.
    const bootstrapEmail = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? '').trim().toLowerCase();
    if (!bootstrapEmail || req.firebaseUser.email !== bootstrapEmail) {
      return res.status(403).json({ error: 'forbidden: workspaces are created by invitation only' });
    }

    const { name } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid workspace name' });
    }

    const userId = req.firebaseUser.uid;
    const now = nowISO();

    // Prevent creating multiple workspaces for the same owner right now
    const existingSnap = await db.collection(collections.WORKSPACES).where('ownerId', '==', userId).limit(1).get();
    if (!existingSnap.empty) {
      return res.status(400).json({ error: 'User already owns a workspace' });
    }

    const workspaceRef = await db.collection(collections.WORKSPACES).add({
      name,
      ownerId: userId,
      billingStatus: 'trial', // or 'active' depending on billing setup
      createdAt: now,
      updatedAt: now,
    });

    // The full record, not just the three fields the workspace itself needs. A
    // user written here is the same shape as one written by POST /admin/users,
    // so serializeUser, the dashboard's lastActiveAt count and the users
    // listing's orderBy('email') all see a complete document.
    await db.collection(collections.USERS).doc(userId).set({
      email: req.firebaseUser.email,
      displayName: null,
      workspaceId: workspaceRef.id,
      role: 'admin',
      createdAt: now,
      lastActiveAt: now,
      updatedAt: now,
      inactivityPromptEnabled: USER_PREFERENCES.inactivityPromptEnabled,
      inactivityTimerSeconds: USER_PREFERENCES.inactivityTimerSeconds,
      allowPreUploadBlur: USER_PREFERENCES.allowPreUploadBlur,
      instantClipboardLinks: USER_PREFERENCES.instantClipboardLinks,
      schemaVersion: 1,
    }, { merge: true });

    return res.status(201).json({ id: workspaceRef.id, name, ownerId: userId });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /workspaces/invites (Send an invitation)
// Auth: Admin of the workspace
// ─────────────────────────────────────────────────────────────────
router.post('/workspaces/invites', requireAdmin, async (req, res, next) => {
  try {
    const { email, role } = req.body;
    if (!email || !role) {
      return res.status(400).json({ error: 'Missing email or role' });
    }

    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const workspaceId = req.hammerUser.workspaceId;
    if (!workspaceId) {
      return res.status(403).json({ error: 'Admin is not associated with a workspace' });
    }

    // Generate a secure invite token
    const token = crypto.randomBytes(32).toString('hex');
    const now = nowISO();
    
    // Expires in 7 days
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const inviteRef = await db.collection(collections.INVITATIONS).add({
      workspaceId,
      email: email.toLowerCase(),
      role,
      token, // In production, store hash of token, but we'll store raw for MVP
      invitedBy: req.hammerUser.uid,
      status: 'pending',
      createdAt: now,
      expiresAt,
    });

    // TODO: Actually dispatch an email using SendGrid / Postmark here
    logger.info(`[Invites] Created invite for ${email} to workspace ${workspaceId}. Token: ${token}`);

    return res.status(201).json({ id: inviteRef.id, email, role, message: 'Invitation created' });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /workspaces/join (Accept an invitation)
// Auth: a verified Firebase token. No users document is required — creating one
// is what this route is for, and demanding it first is what made invitations
// impossible to accept (#33).
//
// The invitation is the authorisation: issued by an administrator of the
// workspace, matched against the caller's own verified email, single-use and
// expiring. A valid token on its own gets you nothing here.
// ─────────────────────────────────────────────────────────────────
router.post('/workspaces/join', requireFirebaseUser, async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Missing invite token' });

    const userId = req.firebaseUser.uid;
    const userEmail = req.firebaseUser.email;

    const snap = await db.collection(collections.INVITATIONS)
      .where('token', '==', token)
      .where('status', '==', 'pending')
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(400).json({ error: 'Invalid or expired invitation token' });
    }

    const inviteDoc = snap.docs[0];
    const invite = inviteDoc.data();

    if (new Date() > new Date(invite.expiresAt)) {
      return res.status(400).json({ error: 'Invitation has expired' });
    }

    if (invite.email.toLowerCase() !== userEmail.toLowerCase()) {
      return res.status(400).json({ error: 'Invitation email does not match authenticated user' });
    }

    const now = nowISO();

    // 1. Mark invite as claimed
    await inviteDoc.ref.update({
      status: 'claimed',
      claimedBy: userId,
      claimedAt: now
    });

    // 2. Add user to workspace with specified role.
    //
    // This may be the caller's first record, or an existing user joining a
    // different workspace, so createdAt is preserved where one is already there
    // and the preference defaults only fill gaps. merge:true alone does not do
    // it — merge protects fields absent from the payload, not fields the
    // payload overwrites.
    const userRef = db.collection(collections.USERS).doc(userId);
    const existing = await userRef.get();
    const prior = existing.exists ? existing.data() : {};

    await userRef.set({
      email: userEmail,
      displayName: prior.displayName ?? null,
      workspaceId: invite.workspaceId,
      role: invite.role,
      createdAt: prior.createdAt ?? now,
      lastActiveAt: prior.lastActiveAt ?? now,
      updatedAt: now,
      inactivityPromptEnabled: prior.inactivityPromptEnabled ?? USER_PREFERENCES.inactivityPromptEnabled,
      inactivityTimerSeconds: prior.inactivityTimerSeconds ?? USER_PREFERENCES.inactivityTimerSeconds,
      allowPreUploadBlur: prior.allowPreUploadBlur ?? USER_PREFERENCES.allowPreUploadBlur,
      instantClipboardLinks: prior.instantClipboardLinks ?? USER_PREFERENCES.instantClipboardLinks,
      schemaVersion: prior.schemaVersion ?? 1,
    }, { merge: true });

    return res.json({ message: 'Successfully joined workspace', workspaceId: invite.workspaceId, role: invite.role });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /workspaces/invites (List pending invites for the workspace)
// Auth: Admin
// ─────────────────────────────────────────────────────────────────
router.get('/workspaces/invites', requireAdmin, async (req, res, next) => {
  try {
    const workspaceId = req.hammerUser.workspaceId;
    const snap = await db.collection(collections.INVITATIONS)
      .where('workspaceId', '==', workspaceId)
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'desc')
      .get();

    const invites = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ invites });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
