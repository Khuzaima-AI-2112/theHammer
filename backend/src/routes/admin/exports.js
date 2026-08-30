/**
 * GET /admin/projects/:id/export  —  a Project's Captures as one ZIP
 *
 * The Storyboard is assembled by hand, outside theHammer. This route exists to
 * hand over the raw material in an order a person can work with: the pictures,
 * numbered oldest first, plus an index they can open in a spreadsheet and add
 * their notes to.
 *
 * Two decisions worth knowing:
 *
 * The query runs DESCENDING and the rows are reversed in memory. The composite
 * index on (projectId, uploadedAt DESC) already exists and serves the Activity
 * view; an ascending export would have read the same data through an index that
 * has to be built and deployed first. With a 50-row ceiling the reverse costs
 * nothing.
 *
 * The archive is stored, not deflated. PNG is already compressed, so a second
 * pass spends CPU on a Cloud Run instance to save almost no bytes.
 *
 * Auth: requireAdmin, and the Project must belong to the caller's Workspace.
 */

'use strict';

const express = require('express');
const archiver = require('archiver');
const { Timestamp } = require('firebase-admin/firestore');
const { Storage } = require('@google-cloud/storage');
const { db } = require('../../lib/firestore');
const { requireAdmin } = require('../../middleware/requireAuth');
const { exportLimiter } = require('../../middleware/rateLimiters');
const collections = require('../../lib/collections');
const logger = require('../../lib/logger');

const router = express.Router({ mergeParams: true });

// The ceiling the architecture already chose for an export, and for the same
// reason: a bounded job that fits in one request's memory and time budget.
const MAX_CAPTURES = 50;

const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET || 'thehammer-storage-2026';

/** ISO instant → a file name fragment that is legal on Windows and sorts. */
function stampFor(uploadedAt) {
  const iso = uploadedAt instanceof Timestamp
    ? uploadedAt.toDate().toISOString()
    : new Date(uploadedAt).toISOString();
  return iso.slice(0, 19).replace(/:/g, '-');
}

function isoFor(uploadedAt) {
  return uploadedAt instanceof Timestamp
    ? uploadedAt.toDate().toISOString()
    : new Date(uploadedAt).toISOString();
}

/** RFC 4180: quote a field, and double any quote inside it. */
function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/projects/:id/export', requireAdmin, exportLimiter, async (req, res, next) => {
  try {
    const projectId = req.params.id;

    const projSnap = await db.collection(collections.PROJECTS).doc(projectId).get();
    if (!projSnap.exists) {
      return res.status(404).json({ error: 'project not found' });
    }
    if (projSnap.data().workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'Forbidden: Project belongs to another workspace' });
    }

    // One over the ceiling, so "too many" is distinguishable from "exactly 50".
    const snap = await db.collection(collections.UPLOADS)
      .where('projectId', '==', projectId)
      .orderBy('uploadedAt', 'desc')
      .limit(MAX_CAPTURES + 1)
      .get();

    if (snap.size > MAX_CAPTURES) {
      return res.status(400).json({
        error: `Project has more than ${MAX_CAPTURES} Captures; narrow the Project or export in parts`,
        max: MAX_CAPTURES
      });
    }
    if (snap.empty) {
      return res.status(404).json({ error: 'No captures to export' });
    }

    const rows = snap.docs.map((d) => {
      const v = d.data();
      return {
        gcsPath: v.gcsPath ?? v.path ?? null,
        uploadedAt: v.uploadedAt,
        tool: v.tool ?? '',
        stage: v.stage ?? '',
        tabUrl: v.tabUrl ?? ''
      };
    }).reverse(); // oldest first — the order the Storyboard is built in

    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${projectId}-captures-${today}.zip"`
    );

    const archive = archiver('zip', { zlib: { level: 0 } });
    archive.on('warning', (err) => logger.error('[hammer-api] export archive warning:', err.message));
    archive.on('error', (err) => {
      logger.error('[hammer-api] export archive error:', err.message);
      res.destroy(err);
    });
    archive.pipe(res);

    const bucket = storage.bucket(BUCKET);
    const index = ['number,file,uploadedAt,tool,stage,tabUrl'];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const number = String(i + 1).padStart(3, '0');
      const name = `${number}_${stampFor(row.uploadedAt)}.png`;

      // Awaited one at a time: archiver drains to the response as we go, so
      // peak memory is about one Capture rather than the whole Project.
      const [bytes] = await bucket.file(row.gcsPath).download();
      archive.append(bytes, { name });

      index.push([
        number,
        csvCell(name),
        csvCell(isoFor(row.uploadedAt)),
        csvCell(row.tool),
        csvCell(row.stage),
        csvCell(row.tabUrl)
      ].join(','));
    }

    archive.append(index.join('\r\n') + '\r\n', { name: 'index.csv' });
    await archive.finalize();
  } catch (err) {
    // Once the ZIP has started there is no status line left to change, so the
    // only honest thing is to break the stream: a truncated download fails
    // loudly in every unzip tool, where a short ZIP would not.
    if (res.headersSent) {
      logger.error('[hammer-api] export failed mid-stream:', err.message);
      return res.destroy(err);
    }
    return next(err);
  }
});

module.exports = router;
