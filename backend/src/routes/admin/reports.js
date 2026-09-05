'use strict';

const logger = require('../../lib/logger');


const express = require('express');
const { db } = require('../../lib/firestore');
const { requireAnalyst } = require('../../middleware/requireAuth');
const { refreshVideoReportStatus } = require('../../lib/shotstack');
const collections = require('../../lib/collections');
// Use the Cloud Tasks library if configured, else invoke worker directly (MVP)
// const { CloudTasksClient } = require('@google-cloud/tasks');

const router = express.Router();

function nowISO() { return new Date().toISOString(); }

// requireAnalyst is a role check, not a Workspace check, so every route here
// has to scope its own projectId to the caller's Workspace. The status codes
// and the error bodies are the ones exports.js and storyboards.js already
// answer with; those two keep the check inline at each call site, which was
// fine at one call site apiece and is not at three, so this file follows
// storyboards.js's other precedent (loadOwnedDraft) and extracts it.
//
// It answers the request itself when the Project is out of reach and reports
// having done so, so a caller reads as `if (await denyForeignProject(...)) return;`.
//
// A missing Project is a 404 rather than a 403 because there is no Workspace
// left to compare against; the Project id came from the caller either way, so
// this leaks nothing a 403 would not.
async function denyForeignProject(req, res, projectId) {
  // A report row with no projectId cannot be placed in a Workspace, so it is
  // out of reach for the same reason a deleted Project is. Guarded here rather
  // than left to Firestore, which throws on doc(undefined) and would turn a
  // refusal into a 500.
  if (!projectId) {
    res.status(404).json({ error: 'project not found' });
    return true;
  }
  const projSnap = await db.collection(collections.PROJECTS).doc(projectId).get();
  if (!projSnap.exists) {
    res.status(404).json({ error: 'project not found' });
    return true;
  }
  if (projSnap.data().workspaceId !== req.hammerUser.workspaceId) {
    res.status(403).json({ error: 'Forbidden: Project belongs to another workspace' });
    return true;
  }
  return false;
}

const { analystReportLimiter } = require('../../middleware/rateLimiters');

// POST /reports/generate
router.post('/reports/generate', requireAnalyst, analystReportLimiter, async (req, res, next) => {
  try {
    const { projectId, reportType, dateRange } = req.body;
    if (!projectId || !reportType) {
      return res.status(400).json({ error: 'Missing projectId or reportType' });
    }

    // #8: this route took a projectId on trust, which was survivable only while
    // the metrics were invented — a caller from another Workspace got fiction.
    // Now that the numbers are real, the same request would answer with another
    // Customer's Capture counts, Monitored User count and Session timings.
    if (await denyForeignProject(req, res, projectId)) return;

    const now = nowISO();
    const reportRef = await db.collection(collections.REPORTS).add({
      projectId,
      reportType,
      dateRange: dateRange || null,
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
    const workerEndpoint = reportType === 'ui_state_changes' || reportType === 'text_entry_tracking' 
      ? '/worker/ocr' 
      : '/worker/reports';

    fetch(`${backendUrl}${workerEndpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // In real life, secure this with an internal token or OIDC
        'X-Internal-Secret': process.env.INTERNAL_SECRET || 'dev-secret'
      },
      body: JSON.stringify({ reportId, projectId, reportType, dateRange })
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
    if (await denyForeignProject(req, res, snap.data().projectId)) return;

    // A `storyboard-video` report's status lives on Shotstack, not in
    // Firestore, until this checks and (if the render has finished since
    // the last poll) persists it — see lib/shotstack.js. Every other
    // reportType passes through unchanged.
    const data = await refreshVideoReportStatus(ref, snap.data());

    return res.json({
      status: data.status,
      gcsPath: data.gcsPath || null,
      reportType: data.reportType
    });
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
    if (await denyForeignProject(req, res, projectId)) return;

    const snap = await db.collection(collections.REPORTS)
      .where('projectId', '==', projectId)
      .orderBy('createdAt', 'desc')
      .get();

    // A visit to the list is also a chance to catch up any `storyboard-video`
    // row still `processing` — otherwise a video that finished while the
    // Analyst was away shows stale until something else happens to poll its
    // individual status. refreshVideoReportStatus() is a no-op for every row
    // that isn't exactly that case.
    const reports = await Promise.all(snap.docs.map(async (d) => {
      const data = await refreshVideoReportStatus(d.ref, d.data());
      return { id: d.id, ...data };
    }));
    return res.json({ reports, total: reports.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
