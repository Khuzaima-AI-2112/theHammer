'use strict';

const logger = require('../../lib/logger');


const express = require('express');
const crypto = require('crypto');
const { db } = require('../../lib/firestore');
const { requireAuth, requireAdmin } = require('../../middleware/requireAuth');
const { VALID_ROLES } = require('../../lib/roles');
const collections = require('../../lib/collections');

const router = express.Router();

function nowISO() { return new Date().toISOString(); }

// ─────────────────────────────────────────────────────────────────
// POST /workspaces (Create a new workspace upon Admin signup)
// Auth: Valid Firebase user (any role, though usually new users)
// ─────────────────────────────────────────────────────────────────
router.post('/workspaces', requireAuth('user'), async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid workspace name' });
    }

    const userId = req.hammerUser.uid;
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

    // Update the user document to associate with this workspace and set them as admin
    await db.collection(collections.USERS).doc(userId).set({
      email: req.hammerUser.email,
      workspaceId: workspaceRef.id,
      role: 'admin',
      updatedAt: now,
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
// Auth: Valid Firebase user (usually newly signed up)
// ─────────────────────────────────────────────────────────────────
router.post('/workspaces/join', requireAuth('user'), async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Missing invite token' });

    const userId = req.hammerUser.uid;
    const userEmail = req.hammerUser.email;

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

    // 2. Add user to workspace with specified role
    await db.collection(collections.USERS).doc(userId).set({
      email: userEmail,
      workspaceId: invite.workspaceId,
      role: invite.role,
      updatedAt: now,
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
