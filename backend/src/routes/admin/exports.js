/**
 * GET /admin/projects/:id/export  —  a Project's Captures as one ZIP
 *
 * The Storyboard is assembled by hand, outside theHammer. This route exists to
 * hand over the raw material in an order a person can work with: the pictures,
 * numbered oldest first, plus an index they can open in a spreadsheet and add
 * their notes to.
 *
 * Query params:
 *   ?tool=<toolName>  — export one Tool's Captures only (optional). Same name
 *                       and same meaning as GET /projects/:id/activity, so the
 *                       filter shown on screen is the filter that is exported.
 *
 * Three decisions worth knowing:
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
 * The Tool filter is applied in the Firestore query rather than to the rows it
 * returns, so the 50-Capture ceiling counts the section being exported. That is
 * what lets a Project over the ceiling still be exported one section at a time
 * (#76).
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
const { loadOwnedProject } = require('../../lib/ownership');
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

/**
 * A Tool is free text typed in the extension popup, and it lands in a
 * Content-Disposition header and a file name on someone's disk. Anything that
 * is not plainly safe in both becomes an underscore.
 */
function fileNameSafe(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
}

router.get('/projects/:id/export', requireAdmin, exportLimiter, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    // #75: the Activity view filters by Tool, and the export ignored it, so a
    // filtered export handed back the whole Project. Same parameter name and
    // same meaning as GET /projects/:id/activity.
    const tool = (req.query.tool ?? '').trim();

    if (!await loadOwnedProject(req, res, projectId)) return;

    // The filter belongs in the query, not in a filter() over the rows: the
    // ceiling below counts what the query returned, so filtering afterwards
    // would refuse a section of 3 inside a Project of 60. Served by the
    // existing (projectId, tool, uploadedAt DESC) composite index, which the
    // Activity view already uses.
    let query = db.collection(collections.UPLOADS).where('projectId', '==', projectId);
    if (tool) query = query.where('tool', '==', tool);

    // One over the ceiling, so "too many" is distinguishable from "exactly 50".
    const snap = await query
      .orderBy('uploadedAt', 'desc')
      .limit(MAX_CAPTURES + 1)
      .get();

    if (snap.size > MAX_CAPTURES) {
      return res.status(400).json({
        error: tool
          ? `Tool "${tool}" has more than ${MAX_CAPTURES} Captures in this Project; narrow the date range`
          : `This Project has more than ${MAX_CAPTURES} Captures and an export holds at most ${MAX_CAPTURES}. Filter by Tool in the Activity view and export each section.`,
        max: MAX_CAPTURES
      });
    }
    if (snap.empty) {
      return res.status(404).json({
        error: tool ? `No captures to export for tool "${tool}"` : 'No captures to export'
      });
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
    // Two sections of one Project must not both land as <projectId>-captures
    // .zip, or the second becomes a "(1)" copy and the person assembling the
    // Storyboard cannot tell which is which.
    const stem = tool
      ? `${projectId}-${fileNameSafe(tool)}-captures-${today}`
      : `${projectId}-captures-${today}`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}.zip"`);

    const archive = archiver('zip', { zlib: { level: 0 } });
    archive.on('warning', (err) => logger.error('[hammer-api] export archive warning:', err));
    archive.on('error', (err) => {
      logger.error('[hammer-api] export archive error:', err);
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
      logger.error('[hammer-api] export failed mid-stream:', err);
      return res.destroy(err);
    }
    return next(err);
  }
});

module.exports = router;
