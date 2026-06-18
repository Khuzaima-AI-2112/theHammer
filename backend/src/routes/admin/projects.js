/**
 * Sprint 5.2–5.5  —  /admin/projects  CRUD
 *
 * POST   /admin/projects              → 5.2 create project
 * GET    /admin/projects              → 5.3 list projects
 * GET    /admin/projects/:id          → 5.4 get single project
 * PATCH  /admin/projects/:id          → 5.4 rename project
 * DELETE /admin/projects/:id          → 5.5 delete project + memberships (chunked batch)
 *
 * Auth:   requireAdmin (= requireRole('admin'))
 * CORS:   Handled globally in src/index.js
 */

'use strict';

const express  = require('express');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { db }   = require('../../lib/firestore');
const { requireAdmin } = require('../../middleware/requireAdmin');

const router = express.Router();

function nowISO() { return new Date().toISOString(); }

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

// 5.2  POST /admin/projects
router.post('/projects', requireAdmin, async (req, res, next) => {
  try {
    const name = (req.body?.name ?? '').trim();
    if (!name || name.length > 128) {
      return res.status(400).json({ error: 'name must be 1–128 characters' });
    }
    const now = nowISO();
    const ref = await db.collection('projects').add({
      name,
      adminId:       req.hammerUser.id,
      memberCount:   0,
      createdAt:     now,
      updatedAt:     now,
      schemaVersion: 1,
    });
    const snap = await ref.get();
    return res.status(201).json(serializeDoc(snap));
  } catch (err) { next(err); }
});

// 5.3  GET /admin/projects
router.get('/projects', requireAdmin, async (req, res, next) => {
  try {
    const snap = await db.collection('projects').orderBy('createdAt', 'desc').get();
    const projects = snap.docs.map(serializeDoc);
    return res.json({ projects, total: projects.length });
  } catch (err) { next(err); }
});

// 5.4  GET /admin/projects/:id
router.get('/projects/:id', requireAdmin, async (req, res, next) => {
  try {
    const snap = await db.collection('projects').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'project not found' });
    return res.json(serializeDoc(snap));
  } catch (err) { next(err); }
});

// 5.4  PATCH /admin/projects/:id
router.patch('/projects/:id', requireAdmin, async (req, res, next) => {
  try {
    const name = (req.body?.name ?? '').trim();
    if (!name || name.length > 128) {
      return res.status(400).json({ error: 'name must be 1–128 characters' });
    }
    const ref  = db.collection('projects').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'project not found' });
    await ref.update({ name, updatedAt: nowISO() });
    const updated = await ref.get();
    return res.json(serializeDoc(updated));
  } catch (err) { next(err); }
});

// 5.5  DELETE /admin/projects/:id
// Deletes project doc + all memberships in chunked batches (Firestore 500-op limit).
router.delete('/projects/:id', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const projectRef = db.collection('projects').doc(id);
    const snap       = await projectRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'project not found' });

    const membersSnap = await db.collection('project_memberships')
      .where('projectId', '==', id)
      .get();

    const CHUNK   = 450;
    const docs    = membersSnap.docs;

    // All chunks except the last — memberships only
    for (let i = 0; i < docs.length - CHUNK; i += CHUNK) {
      const batch = db.batch();
      docs.slice(i, i + CHUNK).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }

    // Final batch includes the remaining memberships AND the project doc — atomic
    const finalBatch = db.batch();
    const lastStart  = Math.max(0, docs.length - (docs.length % CHUNK || CHUNK));
    docs.slice(lastStart).forEach(d => finalBatch.delete(d.ref));
    finalBatch.delete(projectRef);
    await finalBatch.commit();

    return res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
