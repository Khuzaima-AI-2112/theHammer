// ─────────────────────────────────────────────────────────────────
// The Hammer — Backend (Sprint 4: adds rate limiting 4.6)
// POST /capture    → Content-Type guard → auth → multer → validate → sanitize → GCS
// POST /upload-url → auth → JSON validate → sanitize → V4 signed URL
// GET  /health     → 200 {status:"ok"} — zero GCS dependency
// ─────────────────────────────────────────────────────────────────
'use strict';

const express   = require('express');
const multer    = require('multer');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const { Storage } = require('@google-cloud/storage');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── 4.6: trust proxy 1 — MANDATORY for Cloud Run.
// Without this all traffic appears from one IP and rate limiting is useless.
app.set('trust proxy', 1);

// ── 4.6: 60 req / IP / min rate limiter ──
const limiter = rateLimit({
  windowMs:          60 * 1000,   // 1 minute
  max:               60,
  standardHeaders:   true,        // sets RateLimit-* headers
  legacyHeaders:     false,
  // express-rate-limit v7 uses handler for custom response
  handler: (req, res, _next, options) => {
    res.status(options.statusCode).json({
      error:      'Too many requests',
      retryAfter: Math.ceil(options.windowMs / 1000)
    });
  }
});

// Apply limiter to all routes EXCEPT /health (uptime check must not be rate-limited)
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  return limiter(req, res, next);
});

// ── JSON body parser — needed for /upload-url ──
app.use(express.json());

// ── GCS ──
const BUCKET_NAME = process.env.GCS_BUCKET;
const gcs = new Storage();

// ── multer — memory storage, 10 MB hard limit ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ─────────────────────────────────────────────────────────────────
// HMAC-based constant-time key comparison.
// Both sides hashed to fixed 32-byte digest before timingSafeEqual.
// ─────────────────────────────────────────────────────────────────
function keysEqual(provided, expected) {
  const h = (s) => crypto.createHmac('sha256', 'hammer-key-check').update(s).digest();
  try {
    return crypto.timingSafeEqual(h(provided), h(expected));
  } catch (_) {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────
// API key auth middleware
// ─────────────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY;
  const provided = req.headers['x-api-key'];
  if (!expected || !provided) {
    return res.status(401).json({ error: 'Missing API key' });
  }
  if (!keysEqual(provided, expected)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────
// Pre-multer Content-Type guard.
// ─────────────────────────────────────────────────────────────────
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
// Sanitize a string field
// ─────────────────────────────────────────────────────────────────
function sanitize(value, maxLen = 64) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\0/g, '')
    .replace(/\.\.[\\/\\]/g, '')
    .replace(/[^a-zA-Z0-9 _.\-]/g, '_')
    .slice(0, maxLen);
}

// ─────────────────────────────────────────────────────────────────
// Build GCS object path
// Format: {projectId}/{userId}/{ISO-ts}_{tool}_{rand4}.png
// ─────────────────────────────────────────────────────────────────
function buildObjectPath(projectId, userId, tool, now = new Date()) {
  const ts = now.toISOString()
    .replace(/:/g, '-')
    .replace(/\./g, '-');
  const rand = crypto.randomBytes(2).toString('hex');
  const toolPart = tool ? `_${sanitize(tool, 32)}` : '';
  return `${sanitize(projectId)}/${sanitize(userId)}/${ts}${toolPart}_${rand}.png`;
}

// ─────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────

// Health check — zero GCS dependency, exempt from rate limiter
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ─────────────────────────────────────────────────────────────────
// POST /upload-url
// Body: { project, tool, name }
// Returns: { signedUrl, path }
// ─────────────────────────────────────────────────────────────────
app.post('/upload-url', requireApiKey, async (req, res) => {
  const { project, tool, name } = req.body || {};

  const missing = [];
  if (!project) missing.push('project');
  if (!tool)    missing.push('tool');
  if (!name)    missing.push('name');
  if (missing.length > 0) {
    return res.status(400).json({ error: 'Missing required fields', missing });
  }

  if (!BUCKET_NAME) {
    console.error('[Hammer backend] GCS_BUCKET env var not set');
    return res.status(500).json({ error: 'Server misconfiguration: GCS_BUCKET not set' });
  }

  const safeProject = sanitize(project);
  const safeTool    = sanitize(tool, 32);
  const safeName    = sanitize(name);
  const objectPath  = buildObjectPath(safeProject, safeName, safeTool);

  try {
    const [signedUrl] = await gcs
      .bucket(BUCKET_NAME)
      .file(objectPath)
      .getSignedUrl({
        version:     'v4',
        action:      'write',
        expires:     Date.now() + 10 * 60 * 1000,
        contentType: 'image/png',
      });

    console.log('[Hammer backend] signed URL issued for', objectPath);
    return res.json({ signedUrl, path: objectPath });

  } catch (err) {
    console.error('[Hammer backend] signing error:', err);
    const status = err.code === 403 ? 403 : 502;
    return res.status(status).json({ error: 'Failed to generate signed URL', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /capture
// ─────────────────────────────────────────────────────────────────
app.post(
  '/capture',
  requireApiKey,
  requireMultipart,
  upload.single('file'),
  (req, res) => {
    const { projectId, userId, tool, tabUrl } = req.body || {};
    const missing = [];
    if (!projectId) missing.push('projectId');
    if (!userId)    missing.push('userId');
    if (missing.length > 0) {
      return res.status(400).json({ error: 'Missing required fields', missing });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Missing required field: file' });
    }
    if (req.file.size === 0) {
      return res.status(400).json({ error: 'file must not be empty (0 bytes)' });
    }

    const safeProject = sanitize(projectId);
    const safeUser    = sanitize(userId);
    const safeTool    = tool ? sanitize(tool, 32) : '';
    const objectPath  = buildObjectPath(safeProject, safeUser, safeTool);

    if (!BUCKET_NAME) {
      console.error('[Hammer backend] GCS_BUCKET env var not set');
      return res.status(500).json({ error: 'Server misconfiguration: GCS_BUCKET not set' });
    }

    const bucket = gcs.bucket(BUCKET_NAME);
    const blob   = bucket.file(objectPath);

    blob.save(req.file.buffer, {
      resumable: false,
      metadata: {
        contentType: 'image/png',
        metadata: {
          projectId:  safeProject,
          userId:     safeUser,
          tool:       safeTool,
          tabUrl:     tabUrl ? tabUrl.slice(0, 500) : '',
          uploadedAt: new Date().toISOString()
        }
      }
    })
    .then(() => {
      console.log('[Hammer backend] uploaded', objectPath, req.file.size, 'bytes');
      return res.json({ success: true, path: objectPath, size: req.file.size });
    })
    .catch((err) => {
      console.error('[Hammer backend] GCS upload error:', err);
      return res.status(502).json({ error: 'GCS upload failed', detail: err.message });
    });
  }
);

// ── 404 fallback ──
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`[Hammer backend] listening on :${PORT}`);
  console.log(`[Hammer backend] GCS_BUCKET=${BUCKET_NAME || '(not set)'}`);
});

module.exports = { app, sanitize, buildObjectPath };
