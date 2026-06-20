'use strict';

const express = require('express');
const { db } = require('../../lib/firestore');
const { requireAnalyst } = require('../../middleware/requireAnalyst');
const { requireAdmin } = require('../../middleware/requireAdmin');
// Use the Cloud Tasks library if configured, else invoke worker directly (MVP)
// const { CloudTasksClient } = require('@google-cloud/tasks');

const router = express.Router();

function nowISO() { return new Date().toISOString(); }

// Simple middleware to accept either requireAdmin (IAP) or requireAnalyst (API Key)
async function requireAuth(req, res, next) {
  if (req.headers['x-api-key']) {
    return requireAnalyst(req, res, next);
  }
  return requireAdmin(req, res, next);
}

// POST /reports/generate
router.post('/reports/generate', requireAuth, async (req, res, next) => {
  try {
    const { projectId, reportType, dateRange } = req.body;
    if (!projectId || !reportType) {
      return res.status(400).json({ error: 'Missing projectId or reportType' });
    }

    const now = nowISO();
    const reportRef = await db.collection('reports').add({
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
    }).catch(err => console.error('[Reports] Failed to trigger worker:', err));

    return res.status(202).json({ reportId, status: 'queued' });
  } catch (err) {
    next(err);
  }
});

// GET /reports/:id/status
router.get('/reports/:id/status', requireAuth, async (req, res, next) => {
  try {
    const snap = await db.collection('reports').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'report not found' });
    
    const data = snap.data();
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
router.get('/reports', requireAuth, async (req, res, next) => {
  try {
    const { projectId } = req.query;
    if (!projectId) {
      return res.status(400).json({ error: 'Missing projectId query param' });
    }

    const snap = await db.collection('reports')
      .where('projectId', '==', projectId)
      .orderBy('createdAt', 'desc')
      .get();
      
    const reports = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ reports, total: reports.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
