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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Api-Key');
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
    .replace(/\0/g, '')
    .replace(/\.\.[\\/]/g, '')
    .replace(/[^a-zA-Z0-9 _.\/\-]/g, '_')
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

function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY;
  const provided = req.headers['x-api-key'];
  if (!expected || !provided) return res.status(401).json({ error: 'Missing API key' });
  if (!keysEqual(provided, expected)) return res.status(401).json({ error: 'Invalid API key' });
  next();
}

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
        schemaVersion: 1
      },
      { merge: false }
    );
    console.log('[hammer-api] Firestore write ✓ | doc:', docId);
  } catch (err) {
    console.error('[hammer-api] Firestore write error (non-fatal):', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// Core routes
// ─────────────────────────────────────────────────────────────────

// ─ Health ─────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─ POST /upload-url ───────────────────────────────────────────────
app.post('/upload-url', requireApiKey, async (req, res, next) => {
  try {
    const { project, tool, name } = req.body || {};
    const missing = [];
    if (!project) missing.push('project');
    if (!tool)    missing.push('tool');
    if (!name)    missing.push('name');
    if (missing.length > 0) return res.status(400).json({ error: 'Missing required fields', missing });
    if (!BUCKET_NAME) return res.status(500).json({ error: 'Server misconfiguration: GCS_BUCKET not set' });

    const objectPath = buildObjectPath(sanitize(project), sanitize(name), sanitize(tool, 32));
    const [signedUrl] = await gcs.bucket(BUCKET_NAME).file(objectPath).getSignedUrl({
      version: 'v4', action: 'write',
      expires: Date.now() + 10 * 60 * 1000,
      contentType: 'image/png'
    });
    return res.json({ signedUrl, path: objectPath });
  } catch (err) {
    return res.status(err.code === 403 ? 403 : 502).json({ error: 'Failed to generate signed URL', detail: err.message });
  }
});

// ─ POST /capture ──────────────────────────────────────────────────
app.post('/capture', requireApiKey, requireMultipart, upload.single('file'), async (req, res, next) => {
  try {
    const { projectId, userId, tool, tabUrl } = req.body || {};
    const missing = [];
    if (!projectId) missing.push('projectId');
    if (!userId)    missing.push('userId');
    if (missing.length > 0) return res.status(400).json({ error: 'Missing required fields', missing });
    if (!req.file)             return res.status(400).json({ error: 'Missing required field: file' });
    if (req.file.size === 0)   return res.status(400).json({ error: 'file must not be empty (0 bytes)' });
    if (!BUCKET_NAME) return res.status(500).json({ error: 'Server misconfiguration: GCS_BUCKET not set' });

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

    await firestoreWrite(objectPath, {
      path: objectPath, bucket: BUCKET_NAME, size: req.file.size,
      projectId: safeProject, userId: safeUser, tool: safeTool,
      tabUrl: safeTabUrl, uploadedAt
    });

    return res.json({ success: true, path: objectPath, size: req.file.size });
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

module.exports = { app, sanitize, buildObjectPath, sha256 };
