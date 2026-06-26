/**
 * Sprint 5.8  —  /admin/projects/:id/activity
 * Sprint 5.11 —  signed URL enrichment added
 *
 * GET /admin/projects/:id/activity
 *   Returns the last N uploads for a project, optionally filtered by tool.
 *   Each upload includes a 15-min V4 signed URL for thumbnail display.
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
const { Storage } = require('@google-cloud/storage');
const { db } = require('../../lib/firestore');
const { requireAdmin } = require('../../middleware/requireAuth');
const collections = require('../../lib/collections');

const router    = express.Router({ mergeParams: true });
const MAX_LIMIT = 500;
const DEF_LIMIT = 100;

// GCS client — uses ADC (Application Default Credentials) on Cloud Run.
const storage   = new Storage();
const BUCKET    = process.env.GCS_BUCKET || 'thehammer-storage-2026';
const bucket    = storage.bucket(BUCKET);

// Signed URL lifetime: 15 minutes. Portal refreshes every 9 min via
// visibilitychange handler so URLs are always valid when the tab is active.
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

async function makeSignedUrl(gcsPath) {
  if (!gcsPath) return null;
  try {
    const [url] = await bucket.file(gcsPath).getSignedUrl({
      version: 'v4',
      action:  'read',
      expires: Date.now() + SIGNED_URL_TTL_MS,
    });
    return url;
  } catch (_) {
    // Non-fatal: return null so the portal degrades to path-only display.
    return null;
  }
}

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

    const projSnap = await db.collection(collections.PROJECTS).doc(projectId).get();
    if (!projSnap.exists) return res.status(404).json({ error: 'project not found' });

    let query = db.collection(collections.UPLOADS)
      .where('projectId', '==', projectId)
      .orderBy('uploadedAt', 'desc')
      .limit(limit + 1);  // fetch one extra to determine hasMore

    if (tool) {
      query = db.collection(collections.UPLOADS)
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
      const userRefs  = userIds.map(id => db.collection(collections.USERS).doc(id));
      const userSnaps = await db.getAll(...userRefs);
      userSnaps.forEach((s) => {
        if (s.exists) {
          const d = s.data();
          userMap[s.id] = { displayName: d.displayName ?? null, email: d.email };
        }
      });
    }

    // Generate signed URLs in parallel — capped to DEF_LIMIT rows so we
    // never generate more than 100 signed URLs per request.
    const signedUrls = await Promise.all(
      uploads.map(u => makeSignedUrl(u.gcsPath))
    );

    const enriched = uploads.map((u, i) => ({
      ...u,
      userDisplayName: userMap[u.userId]?.displayName ?? null,
      userEmail:       userMap[u.userId]?.email        ?? null,
      signedUrl:       signedUrls[i],
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
