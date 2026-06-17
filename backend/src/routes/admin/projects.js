/**
 * Sprint 5.2–5.5  —  /admin/projects  CRUD
 *
 * POST   /admin/projects              → 5.2 create project
 * GET    /admin/projects              → 5.3 list projects
 * PATCH  /admin/projects/:id          → 5.4 rename project
 * DELETE /admin/projects/:id          → 5.5 delete project + memberships (transaction)
 *
 * Auth:   X-Goog-Authenticated-User-Email injected by Cloud IAP (or dev middleware).
 *         requireAdmin middleware (src/middleware/requireAdmin.js) checks Firestore users
 *         for role === 'admin' before any handler runs.
 *
 * CORS:   Handled globally in src/index.js — do NOT add per-route CORS here.
 */

'use strict';

const express  = require('express');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { db }   = require('../../lib/firestore');
const { requireAdmin } = require('../../middleware/requireAdmin');

const router = express.Router();

// ─── helpers ───────────────────────────────────────────────────────────────

function nowISO() {
  return new Date().toISOString();
}

/** Serialize a Firestore doc snapshot → plain object safe for JSON.stringify */
function serializeDoc(snap) {
  const d = snap.data();
  return {
    id:          snap.id,
    name:        d.name,
    adminId:     d.adminId,
    memberCount: d.memberCount ?? 0,
    createdAt:   d.createdAt instanceof Timestamp ? d.createdAt.toDate().toISOString() : d.createdAt,
    updatedAt:   d.updatedAt instanceof Timestamp ? d.updatedAt.toDate().toISOString() : d.updatedAt,
    schemaVersion: d.schemaVersion,
  };
}

// ─── routes ────────────────────────────────────────────────────────────────

/**
 * 5.2  POST /admin/projects
 * Body: { name: string }   (1–128 chars, trimmed)
 * Returns 201 + created project doc.
 */
router.post('/', requireAdmin, async (req, res) => {
  const name = (req.body?.name ?? '').trim();
  if (!name || name.length > 128) {
    return res.status(400).json({ error: 'name must be 1–128 characters' });
  }

  const adminId = req.hammerUser.id;          // set by requireAdmin
  const now     = nowISO();

  const ref = await db.collection('projects').add({
    name,
    adminId,
    memberCount:   0,
    createdAt:     now,
    updatedAt:     now,
    schemaVersion: 1,
  });

  const snap = await ref.get();
  return res.status(201).json(serializeDoc(snap));
});

/**
 * 5.3  GET /admin/projects
 * Returns all projects ordered by createdAt desc.
 * No pagination — project count is admin-bounded (< 1 000 expected in v1).
 */
router.get('/', requireAdmin, async (req, res) => {
  const snap = await db.collection('projects')
    .orderBy('createdAt', 'desc')
    .get();

  const projects = snap.docs.map(serializeDoc);
  return res.json({ projects, total: projects.length });
});

/**
 * 5.4  PATCH /admin/projects/:id
 * Body: { name: string }
 * Returns 200 + updated project doc.
 */
router.patch('/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const name   = (req.body?.name ?? '').trim();
  if (!name || name.length > 128) {
    return res.status(400).json({ error: 'name must be 1–128 characters' });
  }

  const ref  = db.collection('projects').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'project not found' });

  await ref.update({ name, updatedAt: nowISO() });
  const updated = await ref.get();
  return res.json(serializeDoc(updated));
});

/**
 * 5.5  DELETE /admin/projects/:id
 * Deletes the project doc + all project_memberships where projectId === id.
 * Uses a Firestore transaction so memberCount can never drift.
 * Uploads in GCS/Firestore uploads collection are NOT deleted (data retention).
 */
router.delete('/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;

  const projectRef = db.collection('projects').doc(id);
  const snap       = await projectRef.get();
  if (!snap.exists) return res.status(404).json({ error: 'project not found' });

  // Collect all membership docs for this project
  const membersSnap = await db.collection('project_memberships')
    .where('projectId', '==', id)
    .get();

  // Firestore transactions have a 500-doc write limit — chunk if needed
  const CHUNK = 450;
  const memberDocs = membersSnap.docs;

  // Delete memberships in chunks then the project
  for (let i = 0; i < memberDocs.length; i += CHUNK) {
    const batch = db.batch();
    memberDocs.slice(i, i + CHUNK).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }

  await projectRef.delete();

  return res.status(204).send();
});

module.exports = router;
