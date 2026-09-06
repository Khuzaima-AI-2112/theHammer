/**
 * Sprint 5.6–5.7  —  /admin/users  (roster) and /admin/projects/:id/members
 *
 * GET    /admin/users                           → 5.6  list all users
 * GET    /admin/users/:id                       → 5.10 get single user
 * POST   /admin/users                           → 5.6b provision a user
 * GET    /admin/projects/:id/members            → 5.7a list members of a project
 * POST   /admin/projects/:id/members            → 5.7b admit a user to a project
 * DELETE /admin/projects/:id/members/:userId    → 5.7c remove a user from a project
 *
 * Auth:   requireAdmin
 * Writes: memberCount kept consistent via Firestore batch/transaction.
 */

'use strict';

const express  = require('express');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { db }   = require('../../lib/firestore');
const { requireAdmin } = require('../../middleware/requireAuth');
const { VALID_ROLES } = require('../../lib/roles');
const { USER_PREFERENCES } = require('../../lib/defaults');
const collections = require('../../lib/collections');
const {
  belongsToCaller,
  loadOwnedProject,
  unreachableProjectError,
  foreignUserError,
} = require('../../lib/ownership');

const router = express.Router({ mergeParams: true });

function serializeUser(snap) {
  const d = snap.data();
  return {
    id:           snap.id,
    email:        d.email,
    displayName:  d.displayName ?? null,
    role:         d.role,
    createdAt:    d.createdAt instanceof Timestamp ? d.createdAt.toDate().toISOString() : d.createdAt,
    lastActiveAt: d.lastActiveAt instanceof Timestamp ? d.lastActiveAt.toDate().toISOString() : d.lastActiveAt,
    inactivityPromptEnabled: d.inactivityPromptEnabled,
    inactivityTimerSeconds: d.inactivityTimerSeconds ?? USER_PREFERENCES.inactivityTimerSeconds,
    allowPreUploadBlur: d.allowPreUploadBlur ?? USER_PREFERENCES.allowPreUploadBlur,
    instantClipboardLinks: d.instantClipboardLinks ?? USER_PREFERENCES.instantClipboardLinks,
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

// #7 (SEC-07 … SEC-10) — requireAdmin is a role check, not a Workspace check.
// Every route in this file addresses a Monitored User or a Project by id, and
// an id is something the caller supplies, so each one has to prove the record
// it found belongs to the caller's Workspace before answering with it. Written
// as small predicates rather than one guard because the roster routes need the
// answer inside a transaction, where they cannot write a response.
//
// A record with no `workspaceId` is foreign to everyone. That is deliberate:
// before #7 POST /admin/users wrote users without one, and treating those as
// "belongs to whoever asked" would leave exactly the hole these checks close.
// Such a record needs a Workspace stamped on it before an Admin can read or
// edit it again.
//
// #99: both predicates now come from lib/ownership.js. The Project check and
// the Monitored User check stay separate functions there for the same reason
// they were separate here — #7 found a route that checked the Project and not
// the user, and conflating them is how that happened.

// ─── GET /admin/users ──────────────────────────────────────────────────────
// Returns up to 100 users per page, ordered by email asc.
// Supports ?role= and ?projectId= filters, and ?cursor= for next-page token.
const USERS_PAGE_SIZE = 100;

// Pages a list already ordered by email asc, using a user id as the cursor.
// Same contract as the collection query it stands in for: the cursor is
// exclusive, and nextCursor is non-null only when a further page really exists.
function pageByCursor(items, cursor) {
  let start = 0;
  if (cursor) {
    const at = items.findIndex((u) => u.id === cursor);
    if (at !== -1) start = at + 1;
  }
  const lookahead = items.slice(start, start + USERS_PAGE_SIZE + 1);
  const hasMore = lookahead.length > USERS_PAGE_SIZE;
  const page    = hasMore ? lookahead.slice(0, USERS_PAGE_SIZE) : lookahead;
  return { page, nextCursor: hasMore ? page[page.length - 1].id : null };
}

// Firestore cannot join, so a Project filter resolves membership first and then
// reads those Users. Paging then happens over the filtered list, which is what
// stops a filtered page coming back empty while nextCursor is non-null (#46).
// Each User carries its membership, so the portal's "Admitted" column has a
// date to render.
async function usersInProject(projectId) {
  const membSnap = await db.collection(collections.MEMBERSHIPS)
    .where('projectId', '==', projectId)
    .get();
  if (membSnap.empty) return [];

  const memberships = membSnap.docs.map(serializeMembership);
  const userSnaps   = await Promise.all(
    memberships.map((m) => db.collection(collections.USERS).doc(m.userId).get())
  );

  return userSnaps
    .map((snap, i) => (snap.exists ? { ...serializeUser(snap), membership: memberships[i] } : null))
    .filter(Boolean)
    // Plain comparison rather than localeCompare, to stay as close as possible to
    // the orderBy('email', 'asc') the unfiltered branch gets. Not identical: JS
    // compares UTF-16 code units and Firestore orders by UTF-8 bytes, which
    // diverge above U+FFFF. Email addresses do not reach there.
    .sort((a, b) => {
      const x = a.email ?? '', y = b.email ?? '';
      return x < y ? -1 : x > y ? 1 : 0;
    });
}

router.get('/users', requireAdmin, async (req, res, next) => {
  try {
    const role = req.query.role && VALID_ROLES.includes(req.query.role) ? req.query.role : null;

    if (req.query.projectId) {
      // The Project filter reads a roster through a Project id the caller
      // supplied, so it needs the same ownership check as
      // GET /projects/:id/members below.
      if (!await loadOwnedProject(req, res, req.query.projectId)) return;
      let members = await usersInProject(req.query.projectId);
      if (role) members = members.filter((u) => u.role === role);
      const { page, nextCursor } = pageByCursor(members, req.query.cursor);
      return res.json({ users: page, total: page.length, nextCursor });
    }

    // #7: unscoped, this listed every Customer's Monitored Users — name,
    // email and role — to any Admin, with no id to guess first.
    const workspaceId = req.hammerUser.workspaceId;
    let query = db.collection(collections.USERS)
      .where('workspaceId', '==', workspaceId)
      .orderBy('email', 'asc');
    if (role) {
      query = db.collection(collections.USERS)
        .where('workspaceId', '==', workspaceId)
        .where('role', '==', role)
        .orderBy('email', 'asc');
    }
    if (req.query.cursor) {
      const cursorSnap = await db.collection(collections.USERS).doc(req.query.cursor).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }
    const snap  = await query.limit(USERS_PAGE_SIZE + 1).get();
    const hasMore = snap.docs.length > USERS_PAGE_SIZE;
    const docs  = hasMore ? snap.docs.slice(0, USERS_PAGE_SIZE) : snap.docs;
    const users = docs.map(serializeUser);
    const nextCursor = hasMore ? docs[docs.length - 1].id : null;
    return res.json({ users, total: users.length, nextCursor });
  } catch (err) { next(err); }
});

// ─── GET /admin/users/:id ──────────────────────────────────────────────────
router.get('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const snap = await db.collection(collections.USERS).doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'user not found' });
    if (!belongsToCaller(snap, req)) {
      return res.status(403).json({ error: 'forbidden: user belongs to another workspace' });
    }
    return res.json(serializeUser(snap));
  } catch (err) { next(err); }
});

// ─── POST /admin/users ─────────────────────────────────────────────────────
// Provision a new user. Idempotent by email.
router.post('/users', requireAdmin, async (req, res, next) => {
  try {
    const email       = (req.body?.email ?? '').trim().toLowerCase();
    const displayName = (req.body?.displayName ?? '').trim();
    const role        = req.body?.role ?? 'user';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'valid email required' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    const existing = await db.collection(collections.USERS).where('email', '==', email).limit(1).get();
    if (!existing.empty) {
      // Idempotent only inside the caller's own Workspace. An address already
      // held in another Workspace used to be answered with that Monitored
      // User's whole record, which made provisioning a read of someone else's
      // roster — the same disclosure GET /users/:id now refuses, reachable by
      // guessing an email rather than a document id.
      if (!belongsToCaller(existing.docs[0], req)) {
        return res.status(403).json({ error: 'forbidden: that email is already in use' });
      }
      return res.status(200).json(serializeUser(existing.docs[0]));
    }

    const now = nowISO();
    const ref = await db.collection(collections.USERS).add({
      email,
      displayName: displayName || null,
      role,
      // Provisioning placed a user in no Workspace at all, so every ownership
      // check in this file would have had nothing to compare against and the
      // roster query below would never return them. A user provisioned by an
      // Admin belongs to that Admin's Workspace.
      workspaceId: req.hammerUser.workspaceId,
      createdAt:     now,
      lastActiveAt:  now,
      inactivityTimerSeconds: USER_PREFERENCES.inactivityTimerSeconds,
      allowPreUploadBlur: USER_PREFERENCES.allowPreUploadBlur,
      instantClipboardLinks: USER_PREFERENCES.instantClipboardLinks,
      schemaVersion: 1,
    });
    const snap = await ref.get();
    return res.status(201).json(serializeUser(snap));
  } catch (err) { next(err); }
});

// ─── GET /admin/projects/:id/members ──────────────────────────────────────
router.get('/projects/:id/members', requireAdmin, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    if (!await loadOwnedProject(req, res, projectId)) return;

    const membSnap = await db.collection(collections.MEMBERSHIPS)
      .where('projectId', '==', projectId)
      .orderBy('admittedAt', 'asc')
      .get();

    const members = await Promise.all(membSnap.docs.map(async (mSnap) => {
      const m        = serializeMembership(mSnap);
      const userSnap = await db.collection(collections.USERS).doc(m.userId).get();
      m.user = userSnap.exists ? serializeUser(userSnap) : null;
      return m;
    }));

    return res.json({ members, total: members.length });
  } catch (err) { next(err); }
});

// ─── POST /admin/projects/:id/members ─────────────────────────────────────
// Admits a user. Firestore transaction keeps memberCount consistent.
router.post('/projects/:id/members', requireAdmin, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const userId    = (req.body?.userId ?? '').trim();
    const role      = req.body?.role ?? 'user';

    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    const projectRef    = db.collection(collections.PROJECTS).doc(projectId);
    const userRef       = db.collection(collections.USERS).doc(userId);
    const membershipRef = db.collection(collections.MEMBERSHIPS).doc(`${projectId}_${userId}`);

    const result = await db.runTransaction(async (tx) => {
      const [projSnap, userSnap, membSnap] = await Promise.all([
        tx.get(projectRef),
        tx.get(userRef),
        tx.get(membershipRef),
      ]);

      if (!projSnap.exists) throw Object.assign(new Error('project not found'),       { status: 404 });
      if (!belongsToCaller(projSnap, req)) throw unreachableProjectError();
      if (!userSnap.exists) throw Object.assign(new Error('user not found'),           { status: 404 });
      // The Project is in the caller's Workspace by the line above; the
      // Monitored User has to be too. Admitting a foreign one would put a
      // person from another Customer's staff onto this Project, and from then
      // on their Captures, Sessions and reports would be filed here.
      if (!belongsToCaller(userSnap, req)) throw foreignUserError();
      if (membSnap.exists)  throw Object.assign(new Error('membership already exists'),{ status: 409 });

      const now = nowISO();
      tx.set(membershipRef, {
        projectId,
        userId,
        role,
        admittedAt:    now,
        admittedBy:    req.hammerUser.id,
        schemaVersion: 1,
      });
      tx.update(projectRef, { memberCount: FieldValue.increment(1), updatedAt: now });
      return { projectId, userId, role, admittedAt: now };
    });

    return res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ─── DELETE /admin/projects/:id/members/:userId ───────────────────────────
// Removes a user from a project. Decrements memberCount (floored at 0).
router.delete('/projects/:id/members/:userId', requireAdmin, async (req, res, next) => {
  try {
    const { id: projectId, userId } = req.params;
    const projectRef    = db.collection(collections.PROJECTS).doc(projectId);
    const membershipRef = db.collection(collections.MEMBERSHIPS).doc(`${projectId}_${userId}`);

    await db.runTransaction(async (tx) => {
      const [projSnap, membSnap] = await Promise.all([
        tx.get(projectRef),
        tx.get(membershipRef),
      ]);

      if (!projSnap.exists) throw Object.assign(new Error('project not found'),    { status: 404 });
      if (!belongsToCaller(projSnap, req)) throw unreachableProjectError();
      if (!membSnap.exists) throw Object.assign(new Error('membership not found'), { status: 404 });

      tx.delete(membershipRef);
      // Floor memberCount at 0 to guard against any prior inconsistency
      const current = projSnap.data().memberCount ?? 0;
      tx.update(projectRef, {
        memberCount: current > 0 ? FieldValue.increment(-1) : 0,
        updatedAt:   nowISO(),
      });
    });

    return res.status(204).send();
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ─── PATCH /admin/users/:id ────────────────────────────────────────────────
// Update user configuration (e.g., role, inactivityPromptEnabled, inactivityTimerSeconds)
router.patch('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const userId = req.params.id;
    const updates = {};
    if (typeof req.body?.inactivityPromptEnabled === 'boolean') {
      updates.inactivityPromptEnabled = req.body.inactivityPromptEnabled;
    }
    if (typeof req.body?.inactivityTimerSeconds === 'number' && req.body.inactivityTimerSeconds > 0) {
      updates.inactivityTimerSeconds = req.body.inactivityTimerSeconds;
    }
    if (typeof req.body?.allowPreUploadBlur === 'boolean') {
      updates.allowPreUploadBlur = req.body.allowPreUploadBlur;
    }
    if (typeof req.body?.instantClipboardLinks === 'boolean') {
      updates.instantClipboardLinks = req.body.instantClipboardLinks;
    }
    if (req.body?.role && VALID_ROLES.includes(req.body.role)) {
      updates.role = req.body.role;
    }
    
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no valid fields to update' });
    }

    const userRef = db.collection(collections.USERS).doc(userId);
    updates.updatedAt = nowISO();

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw Object.assign(new Error('user not found'), { status: 404 });
      // The most consequential of these routes: `role` is in `updates`, so
      // without this an Admin could promote — or demote — a Monitored User in
      // another Customer's Workspace.
      if (!belongsToCaller(snap, req)) {
        throw Object.assign(new Error('forbidden: user belongs to another workspace'), { status: 403 });
      }

      tx.update(userRef, updates);
    });

    const updatedSnap = await userRef.get();
    return res.json(serializeUser(updatedSnap));
  } catch (err) { 
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err); 
  }
});

module.exports = router;
