/**
 * Sprint 5.6–5.7  —  /admin/users  (roster) and /admin/projects/:id/members
 *
 * GET    /admin/users                           → 5.6 list all users
 * GET    /admin/projects/:id/members            → 5.7a list members of a project
 * POST   /admin/projects/:id/members            → 5.7b admit a user to a project
 * DELETE /admin/projects/:id/members/:userId    → 5.7c remove a user from a project
 *
 * The POST /admin/users (provision a new user) lives here too:
 * POST   /admin/users                           → 5.6b create/provision a user
 *
 * Auth:   requireAdmin middleware.
 * Writes: memberCount kept consistent via Firestore batch/transaction.
 */

'use strict';

const express  = require('express');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { db }   = require('../../lib/firestore');
const { requireAdmin } = require('../../middleware/requireAdmin');

const router = express.Router({ mergeParams: true });

const VALID_ROLES = ['admin', 'analyst', 'instructional_designer', 'user'];

function serializeUser(snap) {
  const d = snap.data();
  return {
    id:           snap.id,
    email:        d.email,
    displayName:  d.displayName ?? null,
    role:         d.role,
    createdAt:    d.createdAt instanceof Timestamp ? d.createdAt.toDate().toISOString() : d.createdAt,
    lastActiveAt: d.lastActiveAt instanceof Timestamp ? d.lastActiveAt.toDate().toISOString() : d.lastActiveAt,
    schemaVersion: d.schemaVersion,
  };
}

function serializeMembership(snap) {
  const d = snap.data();
  return {
    id:         snap.id,
    projectId:  d.projectId,
    userId:     d.userId,
    role:       d.role,
    admittedAt: d.admittedAt instanceof Timestamp ? d.admittedAt.toDate().toISOString() : d.admittedAt,
    admittedBy: d.admittedBy,
    schemaVersion: d.schemaVersion,
  };
}

function nowISO() { return new Date().toISOString(); }

// ─── /admin/users ──────────────────────────────────────────────────────────

/**
 * 5.6  GET /admin/users
 * Returns all users ordered by email.
 * Optional ?role= filter.
 */
router.get('/users', requireAdmin, async (req, res) => {
  let query = db.collection('users').orderBy('email', 'asc');
  if (req.query.role && VALID_ROLES.includes(req.query.role)) {
    query = query.where('role', '==', req.query.role);
  }
  const snap  = await query.get();
  const users = snap.docs.map(serializeUser);
  return res.json({ users, total: users.length });
});

/**
 * 5.6b  POST /admin/users
 * Provision a new user.  Body: { email, displayName, role }
 * Idempotent by email — returns existing doc if email already registered.
 */
router.post('/users', requireAdmin, async (req, res) => {
  const email       = (req.body?.email ?? '').trim().toLowerCase();
  const displayName = (req.body?.displayName ?? '').trim();
  const role        = req.body?.role ?? 'user';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'valid email required' });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
  }

  // Idempotency: check by email
  const existing = await db.collection('users').where('email', '==', email).limit(1).get();
  if (!existing.empty) {
    return res.status(200).json(serializeUser(existing.docs[0]));
  }

  const now = nowISO();
  const ref = await db.collection('users').add({
    email,
    displayName: displayName || null,
    role,
    createdAt:     now,
    lastActiveAt:  now,
    schemaVersion: 1,
  });
  const snap = await ref.get();
  return res.status(201).json(serializeUser(snap));
});

// ─── /admin/projects/:id/members ───────────────────────────────────────────

/**
 * 5.7a  GET /admin/projects/:id/members
 * Lists all members of a project (joins user display info).
 */
router.get('/projects/:id/members', requireAdmin, async (req, res) => {
  const projectId = req.params.id;

  const projSnap = await db.collection('projects').doc(projectId).get();
  if (!projSnap.exists) return res.status(404).json({ error: 'project not found' });

  const membSnap = await db.collection('project_memberships')
    .where('projectId', '==', projectId)
    .orderBy('admittedAt', 'asc')
    .get();

  const members = await Promise.all(membSnap.docs.map(async (mSnap) => {
    const m        = serializeMembership(mSnap);
    const userSnap = await db.collection('users').doc(m.userId).get();
    m.user = userSnap.exists ? serializeUser(userSnap) : null;
    return m;
  }));

  return res.json({ members, total: members.length });
});

/**
 * 5.7b  POST /admin/projects/:id/members
 * Body: { userId: string, role?: string }
 * Admits a user.  Uses a Firestore transaction to keep memberCount consistent.
 * Returns 409 if membership already exists.
 */
router.post('/projects/:id/members', requireAdmin, async (req, res) => {
  const projectId = req.params.id;
  const userId    = (req.body?.userId ?? '').trim();
  const role      = req.body?.role ?? 'user';

  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
  }

  const projectRef    = db.collection('projects').doc(projectId);
  const userRef       = db.collection('users').doc(userId);
  const membershipRef = db.collection('project_memberships').doc(`${projectId}_${userId}`);

  const result = await db.runTransaction(async (tx) => {
    const [projSnap, userSnap, membSnap] = await Promise.all([
      tx.get(projectRef),
      tx.get(userRef),
      tx.get(membershipRef),
    ]);

    if (!projSnap.exists) throw Object.assign(new Error('project not found'), { status: 404 });
    if (!userSnap.exists) throw Object.assign(new Error('user not found'),    { status: 404 });
    if (membSnap.exists)  throw Object.assign(new Error('membership already exists'), { status: 409 });

    const now = nowISO();
    tx.set(membershipRef, {
      projectId,
      userId,
      role,
      admittedAt:    now,
      admittedBy:    req.hammerUser.id,
      schemaVersion: 1,
    });
    tx.update(projectRef, {
      memberCount: FieldValue.increment(1),
      updatedAt:   now,
    });

    return { projectId, userId, role, admittedAt: now };
  });

  return res.status(201).json(result);
});

/**
 * 5.7c  DELETE /admin/projects/:id/members/:userId
 * Removes a user from a project.  Decrements memberCount in a transaction.
 */
router.delete('/projects/:id/members/:userId', requireAdmin, async (req, res) => {
  const { id: projectId, userId } = req.params;

  const projectRef    = db.collection('projects').doc(projectId);
  const membershipRef = db.collection('project_memberships').doc(`${projectId}_${userId}`);

  await db.runTransaction(async (tx) => {
    const [projSnap, membSnap] = await Promise.all([
      tx.get(projectRef),
      tx.get(membershipRef),
    ]);

    if (!projSnap.exists) throw Object.assign(new Error('project not found'), { status: 404 });
    if (!membSnap.exists) throw Object.assign(new Error('membership not found'), { status: 404 });

    tx.delete(membershipRef);
    tx.update(projectRef, {
      memberCount: FieldValue.increment(-1),
      updatedAt:   nowISO(),
    });
  });

  return res.status(204).send();
});

module.exports = router;
