/**
 * Sprint 5.8  —  /admin/projects/:id/activity
 *
 * GET /admin/projects/:id/activity
 *   Returns the last N uploads for a project, optionally filtered by tool.
 *   Query params:
 *     ?tool=<toolName>   — filter by tool name (optional)
 *     ?limit=<n>         — max rows; default 100, max 500
 *     ?after=<uploadedAt ISO> — cursor for pagination (exclusive lower bound)
 *
 * Auth: requireAdmin
 */

'use strict';

const express = require('express');
const { Timestamp } = require('firebase-admin/firestore');
const { db } = require('../../lib/firestore');
const { requireAdmin } = require('../../middleware/requireAdmin');

const router    = express.Router({ mergeParams: true });
const MAX_LIMIT = 500;
const DEF_LIMIT = 100;

function serializeUpload(snap) {
  const d = snap.data();
  return {
    id:            snap.id,
    projectId:     d.projectId,
    userId:        d.userId,
    tool:          d.tool,
    gcsPath:       d.gcsPath    ?? d.path ?? null,
    fileName:      d.fileName   ?? null,
    fileSizeBytes: d.fileSizeBytes ?? d.size ?? null,
    uploadedAt:    d.uploadedAt instanceof Timestamp
                     ? d.uploadedAt.toDate().toISOString()
                     : d.uploadedAt,
    schemaVersion: d.schemaVersion ?? 1,
  };
}

router.get('/projects/:id/activity', requireAdmin, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const tool      = (req.query.tool  ?? '').trim();
    const after     = (req.query.after ?? '').trim();
    const limit     = Math.min(
      parseInt(req.query.limit, 10) || DEF_LIMIT,
      MAX_LIMIT
    );

    const projSnap = await db.collection('projects').doc(projectId).get();
    if (!projSnap.exists) return res.status(404).json({ error: 'project not found' });

    let query = db.collection('uploads')
      .where('projectId', '==', projectId)
      .orderBy('uploadedAt', 'desc')
      .limit(limit + 1);  // fetch one extra to determine hasMore

    if (tool) {
      query = db.collection('uploads')
        .where('projectId', '==', projectId)
        .where('tool', '==', tool)
        .orderBy('uploadedAt', 'desc')
        .limit(limit + 1);
    }

    if (after) {
      query = query.endBefore(after);
    }

    const snap    = await query.get();
    const allDocs = snap.docs;
    const hasMore = allDocs.length > limit;
    const docs    = hasMore ? allDocs.slice(0, limit) : allDocs;
    const uploads = docs.map(serializeUpload);

    // Enrich with user display name — batched getAll (single RPC)
    const userIds  = [...new Set(uploads.map(u => u.userId).filter(Boolean))];
    const userMap  = {};
    if (userIds.length > 0) {
      const userRefs  = userIds.map(id => db.collection('users').doc(id));
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

    const nextCursor = hasMore ? enriched[enriched.length - 1].uploadedAt : null;

    return res.json({
      uploads:    enriched,
      total:      enriched.length,
      hasMore,
      nextCursor,
      projectId,
      tool:       tool  || null,
      limit,
    });
  } catch (err) { next(err); }
});

module.exports = router;
