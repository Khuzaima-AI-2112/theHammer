/**
 * Sprint 5.2–5.5  —  /admin/projects  CRUD
 *
 * POST   /admin/projects              → 5.2 create project
 * GET    /admin/projects              → 5.3 list projects (paginated, 100/page)
 * GET    /admin/projects/:id          → 5.4 get single project
 * PATCH  /admin/projects/:id          → 5.4 rename project
 * DELETE /admin/projects/:id          → 5.5 Purge the Project and everything filed under it (#114)
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
const { getStorage } = require('../../lib/storage');
const { db }   = require('../../lib/firestore');
const { requireAdmin } = require('../../middleware/requireAuth');
const collections = require('../../lib/collections');
const { DEFAULT_LLM_MODEL, SUPPORTED_LLM_MODELS, isSupportedLlmModel } = require('../../lib/models');
const { loadOwnedProject, callerWorkspace } = require('../../lib/ownership');
const { purgeProjectContents, recordPurge } = require('../../lib/purge');

const router = express.Router();

// No `|| 'thehammer-storage-2026'` fallback here, unlike the read paths in
// exports.js and activity.js. This one deletes: a Purge that cannot be told
// which bucket it is emptying must not guess at a live bucket name. The upload
// paths in index.js already treat an unset GCS_BUCKET as a 500-level
// misconfiguration, and so does the Purge.
const BUCKET = process.env.GCS_BUCKET;

function nowISO() { return new Date().toISOString(); }

function serializeDoc(snap) {
  const d = snap.data();
  return {
    id:          snap.id,
    name:        d.name,
    adminId:     d.adminId,
    memberCount: d.memberCount ?? 0,
    webhookUrl:  d.webhookUrl ?? '',
    llmModel:    d.llmModel ?? DEFAULT_LLM_MODEL,
    // #62. Always an ISO string or null, never absent. The portal reads an
    // absent field and a null one the same way, but a field that is sometimes
    // missing is how this went unnoticed for months — nothing distinguished
    // "not sent" from "none yet".
    //
    // No Timestamp branch, unlike createdAt above: stampLastCapture writes the
    // Capture's own `uploadedAt`, which both upload paths produce with
    // toISOString(). Accepting a shape nothing writes would only make a future
    // writer that gets it wrong look correct here.
    lastCaptureAt: d.lastCaptureAt ?? null,
    createdAt:   d.createdAt instanceof Timestamp ? d.createdAt.toDate().toISOString() : d.createdAt,
    updatedAt:   d.updatedAt instanceof Timestamp ? d.updatedAt.toDate().toISOString() : d.updatedAt,
    schemaVersion: d.schemaVersion,
  };
}

/**
 * #108: any string used to be accepted as a model id, and an unsupported one
 * does not fail — it 404s inside the worker, where #8's graceful degradation
 * turns it into a finished Report with no narrative. Refuse it at the edge,
 * loudly, instead.
 *
 * Answers the request itself and returns true when it has, the same shape
 * loadOwnedProject() uses, so a caller reads `if (...) return;`.
 */
function refusedUnsupportedModel(res, llmModel) {
  if (isSupportedLlmModel(llmModel)) return false;
  res.status(400).json({
    error: `llmModel must be one of: ${SUPPORTED_LLM_MODELS.join(', ')}`
  });
  return true;
}

// 5.2  POST /admin/projects
router.post('/projects', requireAdmin, async (req, res, next) => {
  try {
    const name = (req.body?.name ?? '').trim();
    const webhookUrl = (req.body?.webhookUrl ?? '').trim();
    const llmModel = (req.body?.llmModel ?? DEFAULT_LLM_MODEL).trim();
    if (!name || name.length > 128) {
      return res.status(400).json({ error: 'name must be 1–128 characters' });
    }
    if (refusedUnsupportedModel(res, llmModel)) return;
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
    // #101: without this the filter becomes `where('workspaceId', '==', null)`
    // for an Admin who has none, which matches every unstamped Project rather
    // than none of them (lesson 67).
    const workspaceId = callerWorkspace(req, res);
    if (!workspaceId) return;
    let query = db.collection(collections.PROJECTS)
      .where('workspaceId', '==', workspaceId)
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
//
// #116: carries `captureCount`, because the delete confirmation has to state
// how much is about to be destroyed and can only state a number this sends. The
// count is of Captures — rows in `uploads` — which is the number an Admin
// recognises; the object count may differ, because an Abandoned Upload is a row
// whose image never arrived, and it is not shown.
//
// A count() aggregation rather than reading the rows: the Project with the most
// Captures in production has 100, and this runs on every open of the Project.
// It is only on the single-Project route; the list route would pay it per row.
router.get('/projects/:id', requireAdmin, async (req, res, next) => {
  try {
    const snap = await loadOwnedProject(req, res, req.params.id);
    if (!snap) return;
    const captures = await db.collection(collections.UPLOADS)
      .where('projectId', '==', snap.id)
      .count()
      .get();
    return res.json({ ...serializeDoc(snap), captureCount: captures.data().count });
  } catch (err) { next(err); }
});

// 5.4  PATCH /admin/projects/:id
router.patch('/projects/:id', requireAdmin, async (req, res, next) => {
  try {
    const name = (req.body?.name ?? '').trim();
    const webhookUrl = (req.body?.webhookUrl ?? '').trim();
    const llmModel = (req.body?.llmModel ?? DEFAULT_LLM_MODEL).trim();
    if (!name || name.length > 128) {
      return res.status(400).json({ error: 'name must be 1–128 characters' });
    }
    if (refusedUnsupportedModel(res, llmModel)) return;
    const snap = await loadOwnedProject(req, res, req.params.id);
    if (!snap) return;
    const ref = snap.ref;
    await ref.update({ name, webhookUrl, llmModel, updatedAt: nowISO() });
    const updated = await ref.get();
    return res.json(serializeDoc(updated));
  } catch (err) { next(err); }
});

// 5.5  DELETE /admin/projects/:id  —  the Purge (#114, ADR 0015)
//
// Deleting a Project removes the Project, every record filed under it, and
// every object stored under it. This used to remove the Project document and
// its memberships and nothing else, which left 17 unreachable records and 26
// objects in production (#109).
//
// The Project document goes last, after every child and every object. While it
// survives, its children are still addressable, so a Purge that dies halfway is
// a Purge you run again — the route is idempotent, and Purging a
// partially-Purged Project completes it.
router.delete('/projects/:id', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!BUCKET) {
      return res.status(500).json({ error: 'Server misconfiguration: GCS_BUCKET not set' });
    }
    const snap = await loadOwnedProject(req, res, id);
    if (!snap) return;

    const counts = await purgeProjectContents({
      db, bucket: getStorage().bucket(BUCKET), projectId: id,
    });

    // #115: written while the facts are still available, and before the Project
    // document goes. A Purge that fails before this point writes no record and
    // leaves the Project standing, which is the state a retry is for.
    //
    // Known consequence: the record counts what *this* run removed. A Purge
    // that failed after the children and succeeded on the retry therefore
    // records zero children, because by then there were none. Carrying counts
    // across a failed attempt needs state to survive it — a tombstone or a
    // partial record — and ADR 0015 rejected keeping any. The alternative,
    // writing the record first, would leave a record for a Purge that never
    // happened, which is worse: it claims data is gone while it is still there.
    await recordPurge({ db, projectSnap: snap, actorId: req.hammerUser?.id, counts });

    await snap.ref.delete();

    return res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
