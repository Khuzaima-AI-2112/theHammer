'use strict';

const logger = require('../../lib/logger');


const express = require('express');
const { db } = require('../../lib/firestore');
const { requireAnalyst } = require('../../middleware/requireAuth');
const { refreshVideoReportStatus } = require('../../lib/shotstack');
const { settleIfOverdue } = require('../../lib/reportDeadline');
const collections = require('../../lib/collections');
const { loadOwnedProject } = require('../../lib/ownership');
const { resolveInternalSecret } = require('../../lib/internalSecret');
const { readReportArtifact } = require('../../lib/reportArtifact');
// Use the Cloud Tasks library if configured, else invoke worker directly (MVP)
// const { CloudTasksClient } = require('@google-cloud/tasks');

const router = express.Router();

function nowISO() { return new Date().toISOString(); }

// requireAnalyst is a role check, not a Workspace check, so every route here
// has to scope its own projectId to the caller's Workspace. This file used to
// carry its own copy of that check; it now calls lib/ownership.js like every
// other route family (#99, lesson 67). A report row carrying no projectId is
// refused there rather than here.

const { analystReportLimiter } = require('../../middleware/rateLimiters');

// The report type served by the OCR worker (#96, ADR 0017).
//
// There used to be two — `ui_state_changes` and `text_entry_tracking` — and
// they were never two analyses. One pass over a pair of screenshots produces
// both kinds of finding, and the scaffolded prompt already asked for both, so
// offering them separately billed twice for the same reading of the same two
// images. They collapse into one.
const OCR_REPORT_TYPE = 'storyboard_changes';

/**
 * What a `reports` row actually says right now, rather than what was last
 * written to it.
 *
 * Two catch-ups, composed in cost order, and every read path through this file
 * goes through here rather than picking one — a third reader picking only the
 * Shotstack half is how a row goes stale in exactly one place (#127).
 *
 *  - `settleIfOverdue` is local arithmetic: a row whose request Cloud Run
 *    killed without running its `catch` (lib/reportDeadline.js).
 *  - `refreshVideoReportStatus` is a network call to Shotstack, and a no-op
 *    for a row the first has just settled (lib/shotstack.js).
 */
async function freshReportData(ref, data) {
  return refreshVideoReportStatus(ref, await settleIfOverdue(ref, data));
}

// Refused by name rather than falling through to "unknown report type", so a
// caller still asking for one is told what replaced it.
const RETIRED_OCR_REPORT_TYPES = new Set(['ui_state_changes', 'text_entry_tracking']);

// POST /reports/generate
router.post('/reports/generate', requireAnalyst, analystReportLimiter, async (req, res, next) => {
  try {
    const { projectId, reportType, dateRange, storyboardId } = req.body;
    if (!projectId || !reportType) {
      return res.status(400).json({ error: 'Missing projectId or reportType' });
    }

    // #8: this route took a projectId on trust, which was survivable only while
    // the metrics were invented — a caller from another Workspace got fiction.
    // Now that the numbers are real, the same request would answer with another
    // Customer's Capture counts, Monitored User count and Session timings.
    //
    // The snapshot is kept rather than discarded (#103): it is the Project whose
    // Workspace the Report is stamped with below, and it has already been read.
    const projectSnap = await loadOwnedProject(req, res, projectId);
    if (!projectSnap) return;

    if (RETIRED_OCR_REPORT_TYPES.has(reportType)) {
      return res.status(410).json({
        error: `'${reportType}' has been replaced by '${OCR_REPORT_TYPE}', which reports both `
          + 'UI state changes and text entry from a single pass over a Storyboard.'
      });
    }

    // An OCR Report is generated for a Storyboard, not for a Project (ADR 0017):
    // the Analyst has already decided which Captures belong together and in
    // what order, and pairing a Project's Captures by time compares unrelated
    // pages. All of this is checked before the row is written, for #105's
    // reason — a refused report must not leave a row behind describing work
    // that is never going to happen.
    if (reportType === OCR_REPORT_TYPE) {
      if (!storyboardId) {
        return res.status(400).json({ error: `${OCR_REPORT_TYPE} requires a storyboardId` });
      }
      // Two selections, silently disagreeing, is worse than neither: the
      // Storyboard's membership *is* the selection (#95).
      if (dateRange) {
        return res.status(400).json({
          error: 'A storyboardId and a dateRange cannot both be given: the Storyboard is the selection.'
        });
      }
      const draftSnap = await db.collection(collections.STORYBOARD_DRAFTS).doc(storyboardId).get();
      if (!draftSnap.exists || draftSnap.data().projectId !== projectId) {
        // One answer for unreachable, as lib/ownership.js argues: a Storyboard
        // that does not exist and one belonging elsewhere are refused alike, so
        // the status code cannot be used to sort real ids from imaginary ones.
        return res.status(403).json({
          error: 'Forbidden: Storyboard not found or belongs to another project'
        });
      }
    }

    // #105: this route is the only caller of the worker endpoints, and it
    // authenticates to them with the internal secret. With no secret to
    // present, the request it is about to fire would be refused — so say so
    // now, rather than filing a `queued` report no worker can ever pick up.
    // Checked before the row is created for exactly that reason.
    const internalSecret = resolveInternalSecret();
    if (!internalSecret) {
      logger.error('[Reports] INTERNAL_SECRET is not set; cannot dispatch to the worker.');
      return res.status(503).json({ error: 'Report generation is not configured' });
    }

    const now = nowISO();
    const reportRef = await db.collection(collections.REPORTS).add({
      projectId,
      // The Workspace this Report belongs to, denormalised off the Project
      // (#103, ADR 0014). One of three writers of this collection; the other
      // two are in routes/admin/storyboards.js. Any fourth stamps it too — a
      // Report written without it is counted by nobody.
      workspaceId: projectSnap.data().workspaceId,
      reportType,
      dateRange: dateRange || null,
      // Which Storyboard's curated order this Report walks (#96). Null for
      // every other report type, which are scoped to the Project itself.
      storyboardId: storyboardId || null,
      status: 'queued',
      gcsPath: null,
      requestedBy: req.hammerUser?.id || null,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1
    });

    const reportId = reportRef.id;

    // MVP: For now we invoke the worker asynchronously using fetch to an internal endpoint
    // In production, this would enqueue a Cloud Tasks task.
    // We assume backendUrl is available in config, or we just do a local fetch if we had a local port,
    // but in Cloud Run we might need to invoke our own URL.
    // For this MVP, we just trigger the logic asynchronously if we don't have tasks setup yet.
    // To keep it clean, we'll assume the caller of this endpoint or a local worker processes it.
    
    // We will fire and forget an HTTP request to our internal worker endpoint
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 8080}`;
    const workerEndpoint = reportType === OCR_REPORT_TYPE ? '/worker/ocr' : '/worker/reports';

    fetch(`${backendUrl}${workerEndpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': internalSecret
      },
      body: JSON.stringify({ reportId, projectId, reportType, dateRange, storyboardId })
    }).catch(err => logger.error('[Reports] Failed to trigger worker:', err));

    return res.status(202).json({ reportId, status: 'queued' });
  } catch (err) {
    next(err);
  }
});

// GET /reports/:id/status
router.get('/reports/:id/status', requireAnalyst, async (req, res, next) => {
  try {
    const ref = db.collection(collections.REPORTS).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'report not found' });

    // #94: the report id alone used to be enough to read back another
    // Customer's status, gcsPath and reportType. The check comes before
    // refreshVideoReportStatus() so a refused caller cannot make this route
    // poll — or write back — a Shotstack render it has no claim on.
    if (!await loadOwnedProject(req, res, snap.data().projectId)) return;

    // A `storyboard-video` report's status lives on Shotstack, not in
    // Firestore, until this checks and (if the render has finished since
    // the last poll) persists it — see lib/shotstack.js. Every other
    // reportType passes through unchanged.
    // Without this, the portal's own poll is the thing that reads a `queued`
    // row for ever and never notices nothing is behind it.
    const data = await freshReportData(ref, snap.data());

    return res.json({
      status: data.status,
      gcsPath: data.gcsPath || null,
      reportType: data.reportType
    });
  } catch (err) {
    next(err);
  }
});

// GET /reports/:id/artifact
//
// #120. What an artifact is and why reading one is more than a download is in
// lib/reportArtifact.js; this route is the tenancy check in front of it.
//
// Ownership is proven before the object is touched, for #94's reason one route
// further along: a report id must not be enough to read another Customer's
// Report, and it must not be enough to make this route mint a signed URL for
// their bucket object either.
router.get('/reports/:id/artifact', requireAnalyst, async (req, res, next) => {
  try {
    const ref = db.collection(collections.REPORTS).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'report not found' });

    if (!await loadOwnedProject(req, res, snap.data().projectId)) return;

    // Ownership first, as the status route does and for #94's reason, then the
    // same catch-up every other read gets. Without it this route answers "still
    // queued" for ever about a request that died (#127) — the one sentence the
    // 409 below is least able to afford being wrong about.
    const data = await freshReportData(ref, snap.data());

    // A Report that is queued, processing or errored has no artifact to read.
    // Answered as a state rather than a 404 so the viewer can say which one it
    // is — an empty panel is what this issue exists to stop.
    if (data.status !== 'done' || !data.gcsPath) {
      return res.status(409).json({
        // A failed Report carries its own reason where the worker had one worth
        // acting on — "fewer than two included Captures" is something the
        // Analyst can fix, and burying it in a generic sentence would waste it.
        error: data.status === 'error'
          ? (data.error || 'This report failed to generate, so there is nothing to show.')
          : `This report is still ${data.status}. There is no artifact yet.`,
        status: data.status,
      });
    }

    const artifact = await readReportArtifact(data.gcsPath);
    if (!artifact) {
      return res.status(404).json({ error: 'The report artifact is no longer in storage' });
    }

    return res.json({ id: snap.id, reportType: data.reportType, ...artifact });
  } catch (err) {
    next(err);
  }
});

// GET /reports
router.get('/reports', requireAnalyst, async (req, res, next) => {
  try {
    const { projectId } = req.query;
    if (!projectId) {
      return res.status(400).json({ error: 'Missing projectId query param' });
    }

    // #94: the weaker of the two read routes — an arbitrary projectId listed
    // every report another Customer had ever run, with no id to guess first.
    if (!await loadOwnedProject(req, res, projectId)) return;

    const snap = await db.collection(collections.REPORTS)
      .where('projectId', '==', projectId)
      .orderBy('createdAt', 'desc')
      .get();

    // A visit to the list is also a chance to catch up any `storyboard-video`
    // row still `processing` — otherwise a video that finished while the
    // Analyst was away shows stale until something else happens to poll its
    // individual status. refreshVideoReportStatus() is a no-op for every row
    // that isn't exactly that case.
    // …and to settle any row whose request died mid-work (#127), which is the
    // same argument: a `queued` or `processing` row that outlived the request
    // that was doing the work is never going to change on its own.
    const reports = await Promise.all(snap.docs.map(async (d) => {
      const data = await freshReportData(d.ref, d.data());
      return { id: d.id, ...data };
    }));
    return res.json({ reports, total: reports.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
