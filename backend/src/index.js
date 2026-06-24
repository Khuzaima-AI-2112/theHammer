// ─────────────────────────────────────────────────────────────────
// The Hammer — hammer-api
// Routes:
//   GET  /health
//   GET  /me                                   ← Sprint 5 SPA identity shim
//   POST /capture
//   POST /upload-url
//   POST /admin/projects
//   GET  /admin/projects
//   GET  /admin/projects/:id
//   PATCH /admin/projects/:id
//   DELETE /admin/projects/:id
//   POST /admin/projects/:id/members
//   DELETE /admin/projects/:id/members/:userId
//   GET  /admin/projects/:id/activity
//   GET  /admin/users                          ← Sprint 5 task 5.10
//   GET  /admin/users/:id                      ← Sprint 5 task 5.10
//   GET  /admin/me                             ← Sprint 5 task 5.13
// ─────────────────────────────────────────────────────────────────
'use strict';

const express    = require('express');
const multer     = require('multer');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const { Storage } = require('@google-cloud/storage');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Trust proxy — required for Cloud Run rate-limit correctness ──
app.set('trust proxy', 1);

// ── CORS ──────────────────────────────────────────────────────────
const EXTENSION_ID   = process.env.EXTENSION_ID || '';
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  ...(process.env.ADMIN_ORIGIN ? [process.env.ADMIN_ORIGIN] : []),
  ...(EXTENSION_ID ? [`chrome-extension://${EXTENSION_ID}`] : []),
];

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Api-Key,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Rate limiter: 60 req/IP/min; /health exempt ──────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res, _next, options) => {
    res.status(options.statusCode).json({
      error: 'Too many requests',
      retryAfter: Math.ceil(options.windowMs / 1000)
    });
  }
});
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  return limiter(req, res, next);
});

// ── Per-Role Rate Limiters ─────────────────────────────────────────
const analystReportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 requests per hour
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.hammerUser?.id || req.ip,
  handler: (_req, res, _next, options) => {
    res.status(options.statusCode).json({
      error: 'Analyst report rate limit exceeded (10/hr)',
      retryAfter: Math.ceil(options.windowMs / 1000)
    });
  }
});

const videoExportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 requests per hour
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.hammerUser?.id || req.ip,
  handler: (_req, res, _next, options) => {
    res.status(options.statusCode).json({
      error: 'Video export rate limit exceeded (5/hr)',
      retryAfter: Math.ceil(options.windowMs / 1000)
    });
  }
});

app.use(express.json());

// ── GCS ──────────────────────────────────────────────────────────
const BUCKET_NAME = process.env.GCS_BUCKET;
const gcs = new Storage();

// ── Multer (memory storage, 10 MB) ───────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function sanitize(value, maxLen = 64) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\.\./g, '_')
    .replace(/[^a-zA-Z0-9_.\-]/g, '_')
    .slice(0, maxLen);
}

function buildObjectPath(projectId, userId, tool, now = new Date()) {
  const ts   = now.toISOString().replace(/:/g, '-').replace(/\./g, '-');
  const rand = crypto.randomBytes(2).toString('hex');
  const toolPart = tool ? `_${sanitize(tool, 32)}` : '';
  return `${sanitize(projectId)}/${sanitize(userId)}/${ts}${toolPart}_${rand}.png`;
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function keysEqual(provided, expected) {
  const h = (s) => crypto.createHmac('sha256', 'hammer-key-check').update(s).digest();
  try { return crypto.timingSafeEqual(h(provided), h(expected)); }
  catch (_) { return false; }
}

// ─────────────────────────────────────────────────────────────────
// Auth middleware
// ─────────────────────────────────────────────────────────────────

const { requireAuth } = require('./middleware/requireAuth');

function requireMultipart(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (!ct.startsWith('multipart/form-data')) {
    return res.status(400).json({
      error: 'Content-Type must be multipart/form-data',
      received: ct.slice(0, 120) || '(none)'
    });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────
// Firestore helper (uploads collection)
// ─────────────────────────────────────────────────────────────────

const { db } = require('./lib/firestore');

async function firestoreWrite(objectPath, fields) {
  if (!db) return;
  try {
    const docId = encodeURIComponent(objectPath);
    await db.collection('uploads').doc(docId).set(
      {
        path:       fields.path,
        bucket:     fields.bucket,
        size:       fields.size,
        projectId:  fields.projectId,
        userId:     fields.userId,
        tool:       fields.tool,
        tabUrl:     fields.tabUrl,
        uploadedAt: fields.uploadedAt,
        hasSemanticData: fields.hasSemanticData || false,
        schemaVersion: 1
      },
      { merge: false }
    );
    console.log('[hammer-api] Firestore write ✓ | doc:', docId);
  } catch (err) {
    console.error('[hammer-api] Firestore write error (non-fatal):', err.message);
  }
}

async function dispatchWebhook(projectId, payload) {
  try {
    const snap = await db.collection('projects').doc(projectId).get();
    if (snap.exists) {
      const p = snap.data();
      if (p.webhookUrl) {
        fetch(p.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(err => console.error('[hammer-api] Webhook dispatch error:', err.message));
      }
    }
  } catch(err) {
    console.error('[hammer-api] Webhook fetch project error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// Core routes
// ─────────────────────────────────────────────────────────────────

// ─ Health ─────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─ POST /upload-url ───────────────────────────────────────────────
app.post('/upload-url', requireAuth('user'), async (req, res, next) => {
  try {
    const { project, tool, name } = req.body || {};
    const missing = [];
    if (!project) missing.push('project');
    if (!tool)    missing.push('tool');
    if (!name)    missing.push('name');
    if (missing.length > 0) return res.status(400).json({ error: 'Missing required fields', missing });
    if (!BUCKET_NAME) return res.status(500).json({ error: 'Server misconfiguration: GCS_BUCKET not set' });

    // Enforce Tenant Isolation
    const projSnap = await db.collection('projects').doc(project).get();
    if (!projSnap.exists || projSnap.data().workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'Forbidden: Project not found or belongs to another workspace' });
    }

    const objectPath = buildObjectPath(sanitize(project), sanitize(name), sanitize(tool, 32));
    
    if (req.body.semanticData) {
      const jsonPath = objectPath.replace(/\.png$/, '.json');
      const jsonFile = gcs.bucket(BUCKET_NAME).file(jsonPath);
      jsonFile.save(JSON.stringify(req.body.semanticData), {
        contentType: 'application/json'
      }).catch(err => console.error('[hammer-api] Semantic data write error:', err.message));
    }

    const file = gcs.bucket(BUCKET_NAME).file(objectPath);
    const [signedUrl] = await file.getSignedUrl({
      version: 'v4', action: 'write',
      expires: Date.now() + 10 * 60 * 1000,
      contentType: 'image/png'
    });
    const [readUrl] = await file.getSignedUrl({
      version: 'v4', action: 'read',
      expires: Date.now() + 15 * 60 * 1000
    });
    
    dispatchWebhook(sanitize(project), {
      text: `New screenshot capture initiated`,
      attachments: [{
        title: 'Capture Details',
        fields: [
          { title: 'Tool', value: tool || 'Unknown', short: true },
          { title: 'Name', value: name || 'Unknown', short: true },
          { title: 'Link', value: readUrl, short: false }
        ]
      }]
    });

    return res.json({ signedUrl, readUrl, path: objectPath });
  } catch (err) {
    return res.status(err.code === 403 ? 403 : 502).json({ error: 'Failed to generate signed URL', detail: err.message });
  }
});

// ─ POST /capture ──────────────────────────────────────────────────
app.post('/capture', requireAuth('user'), requireMultipart, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Payload Too Large: File exceeds 10MB limit' });
      }
      return res.status(400).json({ error: err.message });
    } else if (err) {
      return next(err);
    }
    next();
  });
}, async (req, res, next) => {
  try {
    const { projectId, userId, tool, tabUrl } = req.body || {};
    const missing = [];
    if (!projectId) missing.push('projectId');
    if (!userId)    missing.push('userId');
    if (missing.length > 0) return res.status(400).json({ error: 'Missing required fields', missing });
    if (!req.file)             return res.status(400).json({ error: 'Missing required field: file' });
    if (req.file.size === 0)   return res.status(400).json({ error: 'file must not be empty (0 bytes)' });
    if (!BUCKET_NAME) return res.status(500).json({ error: 'Server misconfiguration: GCS_BUCKET not set' });

    // Enforce Tenant Isolation
    const projSnap = await db.collection('projects').doc(projectId).get();
    if (!projSnap.exists || projSnap.data().workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'Forbidden: Project not found or belongs to another workspace' });
    }

    const safeProject  = sanitize(projectId);
    const safeUser     = sanitize(userId);
    const safeTool     = tool   ? sanitize(tool, 32)    : '';
    const safeTabUrl   = tabUrl ? tabUrl.slice(0, 500)  : '';
    const objectPath   = buildObjectPath(safeProject, safeUser, safeTool);
    const uploadedAt   = new Date().toISOString();

    const blob = gcs.bucket(BUCKET_NAME).file(objectPath);
    await blob.save(req.file.buffer, {
      resumable: false,
      metadata: {
        contentType: 'image/png',
        metadata: { projectId: safeProject, userId: safeUser, tool: safeTool, tabUrl: safeTabUrl, uploadedAt }
      }
    });

    const hasSemanticData = !!req.body.semanticData;
    if (hasSemanticData) {
      try {
        const parsed = typeof req.body.semanticData === 'string' ? JSON.parse(req.body.semanticData) : req.body.semanticData;
        const jsonPath = objectPath.replace(/\.png$/, '.json');
        const jsonFile = gcs.bucket(BUCKET_NAME).file(jsonPath);
        jsonFile.save(JSON.stringify(parsed), {
          contentType: 'application/json'
        }).catch(err => console.error('[hammer-api] Semantic data write error:', err.message));
      } catch (e) {
        console.error('[hammer-api] Could not parse semanticData');
      }
    }

    await firestoreWrite(objectPath, {
      path: objectPath, bucket: BUCKET_NAME, size: req.file.size,
      projectId: safeProject, userId: safeUser, tool: safeTool,
      tabUrl: safeTabUrl, uploadedAt, hasSemanticData
    });

    const [readUrl] = await blob.getSignedUrl({
      version: 'v4', action: 'read',
      expires: Date.now() + 15 * 60 * 1000
    });

    dispatchWebhook(safeProject, {
      text: `New screenshot captured`,
      attachments: [{
        title: 'Capture Details',
        fields: [
          { title: 'Tool', value: safeTool || 'Unknown', short: true },
          { title: 'User', value: safeUser || 'Unknown', short: true },
          { title: 'URL', value: safeTabUrl || 'Unknown', short: false },
          { title: 'Link', value: readUrl, short: false }
        ]
      }]
    });

    return res.json({ success: true, path: objectPath, size: req.file.size, readUrl });
  } catch (err) {
    return next(err);
  }
});

// ─ POST /session-events ───────────────────────────────────────────
app.post('/session-events', requireAuth('user'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const missing = [];
    if (!body.sessionId) missing.push('sessionId');
    if (!body.projectId) missing.push('projectId');
    if (!body.sessionStart) missing.push('sessionStart');
    if (!body.sessionEnd) missing.push('sessionEnd');
    
    if (missing.length > 0) return res.status(400).json({ error: 'Missing required fields', missing });

    const safeProject = sanitize(body.projectId);

    // Enforce Tenant Isolation
    const projSnap = await db.collection('projects').doc(safeProject).get();
    if (!projSnap.exists || projSnap.data().workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'Forbidden: Project not found or belongs to another workspace' });
    }
    
    // Resolve user from X-Api-Key if possible
    let resolvedUserId = null;
    try {
      const rawKey = req.headers['x-api-key'];
      if (rawKey) {
        const keyHash = sha256(rawKey);
        const keySnap = await db.collection('api_keys').where('keyHash', '==', keyHash).where('isActive', '==', true).limit(1).get();
        if (!keySnap.empty) {
          resolvedUserId = keySnap.docs[0].data().userId;
        }
      }
    } catch(err) {}

    // Calculate trueActiveMs (Duration - any inactivity). We will do simple sessionLength for now,
    // and if we fetch inactivity_events for this session, subtract it.
    let trueActiveMs = null;
    const startMs = new Date(body.sessionStart).getTime();
    const endMs = new Date(body.sessionEnd).getTime();
    if (!isNaN(startMs) && !isNaN(endMs)) {
      let durationMs = endMs - startMs;
      
      // Fetch inactivity for this session to subtract
      try {
        const inactSnap = await db.collection('inactivity_events')
          .where('sessionId', '==', body.sessionId)
          .get();
        
        let inactiveMs = 0;
        inactSnap.forEach(doc => {
          const d = doc.data();
          const iStart = new Date(d.inactiveStart).getTime();
          const iEnd = new Date(d.inactiveEnd).getTime();
          if (!isNaN(iStart) && !isNaN(iEnd)) {
            inactiveMs += (iEnd - iStart);
          }
        });
        trueActiveMs = durationMs - inactiveMs;
        if (trueActiveMs < 0) trueActiveMs = 0;
      } catch (err) {}
    }

    const docId = sanitize(body.sessionId, 64);
    await db.collection('session_events').doc(docId).set({
      sessionId: body.sessionId,
      projectId: safeProject,
      userId: resolvedUserId || null,
      sessionStart: body.sessionStart,
      sessionEnd: body.sessionEnd,
      totalCaptures: body.totalCaptures || 0,
      firstCapturePath: body.firstCapturePath || null,
      lastCapturePath: body.lastCapturePath || null,
      schemaVersion: 1,
      deleteAfter: body.deleteAfter || null,
      flushReason: body.flushReason || null,
      trueActiveMs: trueActiveMs
    }, { merge: true });

    return res.json({ success: true, sessionId: body.sessionId });
  } catch (err) {
    return next(err);
  }
});

// ─ POST /inactivity-events ────────────────────────────────────────
app.post('/inactivity-events', requireAuth('user'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const missing = [];
    if (!body.eventId) missing.push('eventId');
    if (!body.sessionId) missing.push('sessionId');
    if (!body.projectId) missing.push('projectId');
    if (!body.inactiveStart) missing.push('inactiveStart');
    if (!body.inactiveEnd) missing.push('inactiveEnd');
    
    if (missing.length > 0) return res.status(400).json({ error: 'Missing required fields', missing });

    // Enforce Tenant Isolation
    const projSnap = await db.collection('projects').doc(sanitize(body.projectId)).get();
    if (!projSnap.exists || projSnap.data().workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'Forbidden: Project not found or belongs to another workspace' });
    }

    const resolvedUserId = req.hammerUser.uid;

    const docId = sanitize(body.eventId, 64);
    await db.collection('inactivity_events').doc(docId).set({
      eventId: body.eventId,
      sessionId: body.sessionId,
      projectId: sanitize(body.projectId),
      userId: resolvedUserId || null,
      inactiveStart: body.inactiveStart,
      inactiveEnd: body.inactiveEnd,
      durationMs: new Date(body.inactiveEnd).getTime() - new Date(body.inactiveStart).getTime(),
      schemaVersion: 1
    }, { merge: true });

    return res.json({ success: true, eventId: body.eventId });
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────
// Admin routers (Sprint 5)
// All route-level auth is handled inside each router via requireRole().
// ─────────────────────────────────────────────────────────────────
module.exports = { app, sanitize, buildObjectPath, sha256, analystReportLimiter, videoExportLimiter };

app.use('/',       require('./routes/admin/me'));
app.use('/admin',  require('./routes/admin/projects'));
app.use('/admin',  require('./routes/admin/users'));
app.use('/admin',  require('./routes/admin/activity'));
app.use('/admin',  require('./routes/admin/reports'));
app.use('/admin',  require('./routes/admin/dashboard'));
app.use('/admin',  require('./routes/admin/workspaces'));

// ─────────────────────────────────────────────────────────────────
// Internal Worker Endpoints
// ─────────────────────────────────────────────────────────────────
const workerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30, // 30 requests per hour
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res, _next, options) => {
    res.status(options.statusCode).json({ error: 'Worker rate limit exceeded (30/hr)' });
  }
});

const { generateStandardReport } = require('./worker/reportsWorker');
const { generateOcrReport } = require('./worker/ocrWorker');

app.post('/worker/reports', express.json(), workerLimiter, (req, res) => {
  const { reportId, projectId, reportType, dateRange } = req.body;
  generateStandardReport(reportId, projectId, reportType, dateRange);
  res.status(202).send();
});

app.post('/worker/ocr', express.json(), workerLimiter, (req, res) => {
  const { reportId, projectId, reportType, dateRange } = req.body;
  generateOcrReport(reportId, projectId, reportType, dateRange);
  res.status(202).send();
});

// ─ 404 fallback ───────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─ Global error handler (MUST be last app.use) ───────────────────
const { errorHandler } = require('./middleware/errorHandler');
app.use(errorHandler);

// ─ Start ──────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[hammer-api] listening on :${PORT}`);
    console.log(`[hammer-api] GCS_BUCKET=${BUCKET_NAME || '(not set)'}`);
    console.log(`[hammer-api] EXTENSION_ID=${EXTENSION_ID || '(not set — CORS for extension disabled)'}`);
  });
}
