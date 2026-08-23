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

const logger = require('./lib/logger');


const express    = require('express');
const multer     = require('multer');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const { Storage } = require('@google-cloud/storage');
const collections = require('./lib/collections');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Trust proxy — required for Cloud Run rate-limit correctness ──
app.set('trust proxy', 1);

// ── CORS ──────────────────────────────────────────────────────────
const EXTENSION_ID   = process.env.EXTENSION_ID || '';
const ALLOWED_ORIGINS = [
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : []),
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
const { analystReportLimiter, videoExportLimiter } = require('./middleware/rateLimiters');

app.use(express.json());

// ── GCS ──────────────────────────────────────────────────────────
const BUCKET_NAME = process.env.GCS_BUCKET;
const gcs = new Storage();

// ── Upload limits ────────────────────────────────────────────────
// The ceiling itself lives in lib/defaults.js, which megamind.md names the OSOT
// for configuration defaults and which /admin/me reports as the enforced upload
// size. Read it, do not restate it.
const { CONFIG_DEFAULTS } = require('./lib/defaults');
const MAX_UPLOAD_BYTES = CONFIG_DEFAULTS.maxFileSizeBytes;
const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / (1024 * 1024);

// A Capture is always a PNG: buildObjectPath() names the object .png and the
// bucket write hardcodes image/png, so anything else would be stored under a
// content type it isn't.
const ACCEPTED_UPLOAD_TYPE = 'image/png';

// The pre-multer guard reads Content-Length, which covers the whole multipart
// envelope: the file plus its part headers, boundaries and the other fields.
// The allowance keeps a legitimate at-the-limit file from being refused for the
// envelope around it, and leaves multer's own limit as the exact per-file check.
//
// Two bounds this leaves open, both closed by that multer limit rather than by
// the guard, and neither of which lets memory grow past MAX_UPLOAD_BYTES:
//   - a body between the file limit and the limit plus the allowance
//   - a chunked request, which carries no Content-Length to judge
const MULTIPART_ENVELOPE_ALLOWANCE = 64 * 1024;
const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + MULTIPART_ENVELOPE_ALLOWANCE;

// How much of a refused upload the server will read and throw away so the client
// can receive its 413 (see rejectOversizedUpload). Content-Length is
// attacker-controlled, so draining without a ceiling would let one request cost
// the server arbitrary bandwidth. The budget covers a plausibly oversized
// Capture — a real client still gets its answer — and cuts off anything beyond.
const DRAIN_BUDGET_BYTES = 2 * MAX_REQUEST_BYTES;

// ── Multer (memory storage, PNG only, size-limited) ──────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  // Runs as the part header is parsed, before the file contents are buffered.
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== ACCEPTED_UPLOAD_TYPE) {
      const err = new Error(`Unsupported file type: expected ${ACCEPTED_UPLOAD_TYPE}, received ${file.mimetype}`);
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  }
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

const { requireAuth, requireAdmin } = require('./middleware/requireAuth');

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

/**
 * SEC-07 — refuse an oversized upload before multer buffers it.
 *
 * The verdict comes from the Content-Length header alone, so an over-limit
 * request is answered without reading its body into memory. A request that
 * declares no length, or one inside the limit, passes through to multer, whose
 * own fileSize limit remains the exact per-file check.
 */
function rejectOversizedUpload(req, res, next) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    let replied = false;
    const reply = () => {
      if (replied || res.headersSent) return;
      replied = true;
      res.status(413).json({
        error: `Payload Too Large: request exceeds ${MAX_UPLOAD_MB}MB limit`,
        declaredBytes: declared
      });
    };

    // Answering while the client is still uploading resets the socket, and the
    // client sees ECONNRESET rather than the 413 — which would leave the
    // extension retrying a Capture that can never succeed. So drain the rest of
    // the request, then answer. Draining discards bytes as they arrive; nothing
    // is buffered and multer never runs, which is the point of refusing here.
    //
    // The drain is capped: Content-Length is attacker-controlled, so a request
    // claiming to be enormous would otherwise cost the server that much reading.
    // Past the budget the client loses its answer, which is the right trade at
    // a size no real Capture reaches.
    let drained = 0;
    req.on('data', (chunk) => {
      drained += chunk.length;
      if (drained > DRAIN_BUDGET_BYTES) {
        reply();
        req.destroy();
      }
    });
    req.on('end', reply);
    req.on('error', reply);
    req.on('aborted', reply);
    return;
  }
  next();
}

// ─────────────────────────────────────────────────────────────────
// Firestore helper (uploads collection)
// ─────────────────────────────────────────────────────────────────

const { db } = require('./lib/firestore');

// Returns null on success, error message string on failure
async function firestoreWrite(objectPath, fields) {
  if (!db) return 'Firestore not initialized';
  try {
    const docId = encodeURIComponent(objectPath);
    await db.collection(collections.UPLOADS).doc(docId).set(
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
    logger.info('[hammer-api] Firestore write ✓ | doc:', docId);
    return null;
  } catch (err) {
    logger.error('[hammer-api] Firestore write error:', err.message);
    return err.message;
  }
}

// ── SSRF guard: only allow https:// to non-private addresses ──────
const PRIVATE_IP_RE = /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|127\.|169\.254\.|::1$|fc00:|fd)/;

function validateWebhookUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch (_) { return 'Invalid URL'; }
  if (parsed.protocol !== 'https:') return 'Webhook URL must use https://';
  const host = parsed.hostname;
  if (PRIVATE_IP_RE.test(host)) return 'Webhook URL resolves to a private/reserved address';
  if (host === 'metadata.google.internal') return 'Webhook URL targets GCP metadata server';
  return null; // valid
}

async function dispatchWebhook(projectId, payload) {
  try {
    const snap = await db.collection(collections.PROJECTS).doc(projectId).get();
    if (snap.exists) {
      const p = snap.data();
      if (p.webhookUrl) {
        const ssrfErr = validateWebhookUrl(p.webhookUrl);
        if (ssrfErr) {
          logger.error('[hammer-api] Webhook blocked (SSRF):', ssrfErr, '| url:', p.webhookUrl);
          return;
        }
        fetch(p.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(err => logger.error('[hammer-api] Webhook dispatch error:', err.message));
      }
    }
  } catch(err) {
    logger.error('[hammer-api] Webhook fetch project error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// Core routes
// ─────────────────────────────────────────────────────────────────

// ─ Health ─────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    if (!db) throw new Error('Firestore db object missing');
    await db.collection(collections.PROJECTS).limit(1).get();
    res.json({ status: 'ok', firestore: 'connected' });
  } catch (err) {
    logger.error('[hammer-api] Health check failed:', err.message);
    res.status(503).json({ status: 'error', reason: 'Firestore disconnected' });
  }
});

// ─ POST /upload-url ───────────────────────────────────────────────
app.post('/upload-url', requireAuth('user'), async (req, res, next) => {
  try {
    const { project, tool } = req.body || {};
    const missing = [];
    if (!project) missing.push('project');
    if (!tool)    missing.push('tool');
    if (missing.length > 0) return res.status(400).json({ error: 'Missing required fields', missing });
    if (!BUCKET_NAME) return res.status(500).json({ error: 'Server misconfiguration: GCS_BUCKET not set' });

    // Enforce Tenant Isolation
    const projSnap = await db.collection(collections.PROJECTS).doc(project).get();
    if (!projSnap.exists || projSnap.data().workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'Forbidden: Project not found or belongs to another workspace' });
    }

    const objectPath = buildObjectPath(sanitize(project), req.hammerUser.id, sanitize(tool, 32));
    
    if (req.body.semanticData) {
      const jsonPath = objectPath.replace(/\.png$/, '.json');
      const jsonFile = gcs.bucket(BUCKET_NAME).file(jsonPath);
      jsonFile.save(JSON.stringify(req.body.semanticData), {
        contentType: 'application/json'
      }).catch(err => logger.error('[hammer-api] Semantic data write error:', err.message));
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
          { title: 'User', value: req.hammerUser.displayName || req.hammerUser.email || req.hammerUser.id, short: true },
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
app.post('/capture', requireAuth('user'), requireMultipart, rejectOversizedUpload, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `Payload Too Large: File exceeds ${MAX_UPLOAD_MB}MB limit` });
      }
      return res.status(400).json({ error: err.message });
    } else if (err) {
      // fileFilter rejections carry their own status; errorHandler honours it.
      return next(err);
    }
    next();
  });
}, async (req, res, next) => {
  try {
    const { projectId, tool, tabUrl } = req.body || {};
    const missing = [];
    if (!projectId) missing.push('projectId');
    if (missing.length > 0) return res.status(400).json({ error: 'Missing required fields', missing });
    if (!req.file)             return res.status(400).json({ error: 'Missing required field: file' });
    if (req.file.size === 0)   return res.status(400).json({ error: 'file must not be empty (0 bytes)' });
    if (!BUCKET_NAME) return res.status(500).json({ error: 'Server misconfiguration: GCS_BUCKET not set' });

    // Enforce Tenant Isolation
    const projSnap = await db.collection(collections.PROJECTS).doc(projectId).get();
    if (!projSnap.exists || projSnap.data().workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'Forbidden: Project not found or belongs to another workspace' });
    }

    const safeProject  = sanitize(projectId);
    const safeUser     = req.hammerUser.id;
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
        }).catch(err => logger.error('[hammer-api] Semantic data write error:', err.message));
      } catch (e) {
        logger.error('[hammer-api] Could not parse semanticData');
      }
    }

    const firestoreErr = await firestoreWrite(objectPath, {
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

    const resp = { success: true, path: objectPath, size: req.file.size, readUrl };
    if (firestoreErr) resp.warning = `Metadata write failed: ${firestoreErr}`;
    return res.json(resp);
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
    
    // Identity is guaranteed by requireAuth middleware
    const resolvedUserId = req.hammerUser.uid;

    // Calculate trueActiveMs (Duration - any inactivity). We will do simple sessionLength for now,
    // and if we fetch inactivity_events for this session, subtract it.
    let trueActiveMs = null;
    const startMs = new Date(body.sessionStart).getTime();
    const endMs = new Date(body.sessionEnd).getTime();
    if (!isNaN(startMs) && !isNaN(endMs)) {
      let durationMs = endMs - startMs;
      
      // Fetch inactivity for this session to subtract
      try {
        const inactSnap = await db.collection(collections.INACTIVITY_EVENTS)
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
    await db.collection(collections.SESSION_EVENTS).doc(docId).set({
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
    const projSnap = await db.collection(collections.PROJECTS).doc(sanitize(body.projectId)).get();
    if (!projSnap.exists || projSnap.data().workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'Forbidden: Project not found or belongs to another workspace' });
    }

    const resolvedUserId = req.hammerUser.uid;

    const docId = sanitize(body.eventId, 64);
    await db.collection(collections.INACTIVITY_EVENTS).doc(docId).set({
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

const requireWorkerAuth = (req, res, next) => {
  const secret = req.headers['x-internal-secret'];
  if (secret && secret === (process.env.INTERNAL_SECRET || 'dev-secret')) {
    return next();
  }
  return requireAdmin(req, res, next);
};

app.post('/worker/reports', express.json(), workerLimiter, requireWorkerAuth, (req, res) => {
  const { reportId, projectId, reportType, dateRange } = req.body;
  generateStandardReport(reportId, projectId, reportType, dateRange);
  res.status(202).send();
});

app.post('/worker/ocr', express.json(), workerLimiter, requireWorkerAuth, (req, res) => {
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
    logger.info(`[hammer-api] listening on :${PORT}`);
    logger.info(`[hammer-api] GCS_BUCKET=${BUCKET_NAME || '(not set)'}`);
    logger.info(`[hammer-api] EXTENSION_ID=${EXTENSION_ID || '(not set — CORS for extension disabled)'}`);
  });
}

module.exports = { app, sanitize, buildObjectPath, sha256, rejectOversizedUpload, analystReportLimiter, videoExportLimiter };
