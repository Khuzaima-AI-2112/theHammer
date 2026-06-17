/**
 * Sprint 5.8  —  /admin/projects/:id/activity
 *
 * GET /admin/projects/:id/activity
 *   Returns the last N uploads for a project, optionally filtered by tool.
 *   Query params:
 *     ?tool=<toolName>   — filter by tool name (optional)
 *     ?limit=<n>         — max rows; default 100, max 500
 *
 * The uploads collection (flat, with projectId field) was established in
 * earlier sprints.  This route is read-only — it does not write.
 *
 * Auth: requireAdmin middleware.
 */

'use strict';

const express = require('express');
const { Timestamp } = require('firebase-admin/firestore');
const { db } = require('../../lib/firestore');
const { requireAdmin } = require('../../middleware/requireAdmin');

const router  = express.Router({ mergeParams: true });
const MAX_LIMIT = 500;
const DEF_LIMIT = 100;

function serializeUpload(snap) {
  const d = snap.data();
  return {
    id:          snap.id,
    projectId:   d.projectId,
    userId:      d.userId,
    tool:        d.tool,
    gcsPath:     d.gcsPath ?? null,
    fileName:    d.fileName ?? null,
    fileSizeBytes: d.fileSizeBytes ?? null,
    uploadedAt:  d.uploadedAt instanceof Timestamp
                   ? d.uploadedAt.toDate().toISOString()
                   : d.uploadedAt,
    schemaVersion: d.schemaVersion ?? 1,
  };
}

/**
 * GET /admin/projects/:id/activity
 */
router.get('/projects/:id/activity', requireAdmin, async (req, res) => {
  const projectId = req.params.id;
  const tool      = (req.query.tool ?? '').trim();
  const limit     = Math.min(
    parseInt(req.query.limit, 10) || DEF_LIMIT,
    MAX_LIMIT
  );

  // Validate project exists
  const projSnap = await db.collection('projects').doc(projectId).get();
  if (!projSnap.exists) return res.status(404).json({ error: 'project not found' });

  let query = db.collection('uploads')
    .where('projectId', '==', projectId)
    .orderBy('uploadedAt', 'desc')
    .limit(limit);

  if (tool) {
    query = db.collection('uploads')
      .where('projectId', '==', projectId)
      .where('tool', '==', tool)
      .orderBy('uploadedAt', 'desc')
      .limit(limit);
  }

  const snap    = await query.get();
  const uploads = snap.docs.map(serializeUpload);

  // Enrich with user display name where available (batched getAll)
  const userIds  = [...new Set(uploads.map(u => u.userId).filter(Boolean))];
  const userMap  = {};
  if (userIds.length > 0) {
    const userRefs = userIds.map(id => db.collection('users').doc(id));
    const userSnaps = await db.getAll(...userRefs);
    userSnaps.forEach((s) => {
      if (s.exists) {
        const d = s.data();
        userMap[s.id] = { displayName: d.displayName ?? null, email: d.email };
      }
    });
  }

  const enriched = uploads.map(u => ({
    ...u,
    userDisplayName: userMap[u.userId]?.displayName ?? null,
    userEmail:       userMap[u.userId]?.email        ?? null,
  }));

  return res.json({
    uploads:  enriched,
    total:    enriched.length,
    projectId,
    tool:     tool || null,
    limit,
  });
});

module.exports = router;
