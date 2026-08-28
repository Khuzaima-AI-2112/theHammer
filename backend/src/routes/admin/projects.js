/**
 * Sprint 5.2–5.5  —  /admin/projects  CRUD
 *
 * POST   /admin/projects              → 5.2 create project
 * GET    /admin/projects              → 5.3 list projects (paginated, 100/page)
 * GET    /admin/projects/:id          → 5.4 get single project
 * PATCH  /admin/projects/:id          → 5.4 rename project
 * DELETE /admin/projects/:id          → 5.5 delete project + memberships (chunked batch)
 *
 * Auth:   requireAdmin (= requireRole('admin'))
 * CORS:   Handled globally in src/index.js
 *
 * NOTE (5.3 deviation): memberCount is served from the denormalized field on
 * the project doc, not from a live Firestore count() aggregation at query time.
 * The field is kept consistent transactionally by tasks 5.6 and 5.7 (POST/DELETE
 * /members). This is architecturally superior to a per-project count() RPC on
 * every list call (avoids N extra reads). Recorded per Guardrail 6 / Lesson 7.
 *
 * SRE Audit (2026-06-23): Added cursor-based pagination (limit 100) to GET
 * /admin/projects to prevent OOM on large workspaces.
 */

'use strict';

const express  = require('express');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { db }   = require('../../lib/firestore');
const { requireAdmin } = require('../../middleware/requireAuth');
const collections = require('../../lib/collections');

const router = express.Router();

function nowISO() { return new Date().toISOString(); }

function serializeDoc(snap) {
  const d = snap.data();
  return {
    id:          snap.id,
    name:        d.name,
    adminId:     d.adminId,
    memberCount: d.memberCount ?? 0,
    webhookUrl:  d.webhookUrl ?? '',
    llmModel:    d.llmModel ?? 'gemini-1.5-flash',
    createdAt:   d.createdAt instanceof Timestamp ? d.createdAt.toDate().toISOString() : d.createdAt,
    updatedAt:   d.updatedAt instanceof Timestamp ? d.updatedAt.toDate().toISOString() : d.updatedAt,
    schemaVersion: d.schemaVersion,
  };
}

// 5.2  POST /admin/projects
router.post('/projects', requireAdmin, async (req, res, next) => {
  try {
    const name = (req.body?.name ?? '').trim();
    const webhookUrl = (req.body?.webhookUrl ?? '').trim();
    const llmModel = (req.body?.llmModel ?? 'gemini-1.5-flash').trim();
    if (!name || name.length > 128) {
      return res.status(400).json({ error: 'name must be 1–128 characters' });
    }
    const now = nowISO();

    // #47: the creator must be a member, not merely the adminId. Every read
    // path that decides who may use a Project resolves project_memberships,
    // so a Project created without one is invisible to its own creator.
    // Written in the same transaction as the Project, and with the same
    // memberCount discipline as POST /projects/:id/members, so the count and
    // the membership rows cannot disagree.
    const ref = db.collection(collections.PROJECTS).doc();
    const membershipRef = db.collection(collections.MEMBERSHIPS)
      .doc(`${ref.id}_${req.hammerUser.id}`);

    await db.runTransaction(async (tx) => {
      tx.set(ref, {
        workspaceId: req.hammerUser.workspaceId,
        name,
        webhookUrl,
        llmModel,
        // adminId records who created the Project. It grants no access on its
        // own; the membership row below is what does.
        adminId:       req.hammerUser.id,
        memberCount:   1,
        createdAt:     now,
        updatedAt:     now,
        schemaVersion: 1,
      });
      tx.set(membershipRef, {
        projectId:     ref.id,
        userId:        req.hammerUser.id,
        role:          'user',
        admittedAt:    now,
        admittedBy:    req.hammerUser.id,
        schemaVersion: 1,
      });
    });

    const snap = await ref.get();
    return res.status(201).json(serializeDoc(snap));
  } catch (err) { next(err); }
});

// 5.3  GET /admin/projects — paginated (max 100 per page)
// Supports ?cursor= for next-page token (pass the last project ID).
router.get('/projects', requireAdmin, async (req, res, next) => {
  try {
    const PAGE_SIZE = 100;
    let query = db.collection(collections.PROJECTS)
      .where('workspaceId', '==', req.hammerUser.workspaceId)
      .orderBy('createdAt', 'desc');
    if (req.query.cursor) {
      const cursorSnap = await db.collection(collections.PROJECTS).doc(req.query.cursor).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }
    const snap = await query.limit(PAGE_SIZE + 1).get();
    const hasMore = snap.docs.length > PAGE_SIZE;
    const docs = hasMore ? snap.docs.slice(0, PAGE_SIZE) : snap.docs;
    const projects = docs.map(serializeDoc);
    const nextCursor = hasMore ? docs[docs.length - 1].id : null;
    return res.json({ projects, total: projects.length, nextCursor });
  } catch (err) { next(err); }
});

// 5.4  GET /admin/projects/:id
router.get('/projects/:id', requireAdmin, async (req, res, next) => {
  try {
    const snap = await db.collection(collections.PROJECTS).doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'project not found' });
    if (snap.data().workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'forbidden: project belongs to another workspace' });
    }
    return res.json(serializeDoc(snap));
  } catch (err) { next(err); }
});

// 5.4  PATCH /admin/projects/:id
router.patch('/projects/:id', requireAdmin, async (req, res, next) => {
  try {
    const name = (req.body?.name ?? '').trim();
    const webhookUrl = (req.body?.webhookUrl ?? '').trim();
    const llmModel = (req.body?.llmModel ?? 'gemini-1.5-flash').trim();
    if (!name || name.length > 128) {
      return res.status(400).json({ error: 'name must be 1–128 characters' });
    }
    const ref  = db.collection(collections.PROJECTS).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'project not found' });
    if (snap.data().workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'forbidden: project belongs to another workspace' });
    }
    await ref.update({ name, webhookUrl, llmModel, updatedAt: nowISO() });
    const updated = await ref.get();
    return res.json(serializeDoc(updated));
  } catch (err) { next(err); }
});

// 5.5  DELETE /admin/projects/:id
// Deletes project doc + all memberships in chunked batches (Firestore 500-op limit).
router.delete('/projects/:id', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const projectRef = db.collection(collections.PROJECTS).doc(id);
    const snap       = await projectRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'project not found' });
    if (snap.data().workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'forbidden: project belongs to another workspace' });
    }

    const membersSnap = await db.collection(collections.MEMBERSHIPS)
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
