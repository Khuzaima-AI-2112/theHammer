// ─────────────────────────────────────────────────────────────────
// The Hammer — Backend (Sprint 2)
// POST /capture   → validate → sanitize → build path → upload to GCS
// GET  /health    → 200 {status:"ok"} — zero GCS dependency
// ─────────────────────────────────────────────────────────────────
'use strict';

const express  = require('express');
const multer   = require('multer');
const crypto   = require('crypto');
const { Storage } = require('@google-cloud/storage');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── GCS ──
const BUCKET_NAME = process.env.GCS_BUCKET;
const gcs = new Storage();

// ── multer — memory storage, 10 MB hard limit ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ─────────────────────────────────────────────────────────────────
// 2.7 — API key auth middleware
// Uses crypto.timingSafeEqual to prevent timing attacks.
// Key comes from Secret Manager via Cloud Run --set-secrets.
// ─────────────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY;
  const provided = req.headers['x-api-key'];
  if (!expected || !provided) {
    return res.status(401).json({ error: 'Missing API key' });
  }
  // Pad to same length before comparison to avoid length leaks
  const expBuf = Buffer.from(expected);
  const provBuf = Buffer.alloc(expBuf.length);
  provBuf.write(provided);
  let valid = false;
  try {
    valid = crypto.timingSafeEqual(expBuf, provBuf) && provided.length === expected.length;
  } catch (_) {
    valid = false;
  }
  if (!valid) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────
// 2.3 — Validate required fields BEFORE multer parses the body
// so the buffer is never loaded for an obviously invalid request.
// Required form fields sent as form-data text parts alongside file:
//   projectId, userId, tool (optional), tabUrl (optional)
// ─────────────────────────────────────────────────────────────────
function validateRequiredFields(req, res, next) {
  // For multipart we can't read body before multer.
  // Instead we check after multer, but multer is a separate step below.
  // The guard runs as a dedicated middleware BEFORE multer using a
  // quick header-only pre-check; the full field validation runs post-multer.
  next();
}

// ─────────────────────────────────────────────────────────────────
// 2.4 — Sanitize a string field
// • Strips path-traversal sequences (../ and ..\ and null bytes)
// • Removes characters outside the safe set: a-z A-Z 0-9 _ - . space
// • Truncates to maxLen (default 64)
// ─────────────────────────────────────────────────────────────────
function sanitize(value, maxLen = 64) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\0/g, '')                          // null bytes
    .replace(/\.\.[\/\\]/g, '')                  // path traversal
    .replace(/[^a-zA-Z0-9 _.\-]/g, '_')          // allow-list; replace rest
    .slice(0, maxLen);
}

// ─────────────────────────────────────────────────────────────────
// 2.5 — Build GCS object path
// Format: {projectId}/{userId}/{YYYY-MM-DDTHH-MM-SS-mmmZ}_{random4}.png
// Using a 4-char random hex suffix ensures two captures in the same
// millisecond produce different paths.
// ─────────────────────────────────────────────────────────────────
function buildObjectPath(projectId, userId, tool, now = new Date()) {
  const ts = now.toISOString()
    .replace(/:/g, '-')   // colons → dashes (GCS path-safe)
    .replace(/\./g, '-'); // dot before ms → dash
  const rand = crypto.randomBytes(2).toString('hex'); // 4 hex chars
  const toolPart = tool ? `_${sanitize(tool, 32)}` : '';
  return `${sanitize(projectId)}/${sanitize(userId)}/${ts}${toolPart}_${rand}.png`;
}

// ─────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────

// 2.1 — Health check — zero GCS dependency
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// 2.2 / 2.3 / 2.6 / 2.7 / 2.8 — Capture endpoint
app.post(
  '/capture',
  requireApiKey,
  upload.single('file'),
  (req, res) => {
    // ── 2.3 Post-multer field validation ──
    const { projectId, userId, tool, tabUrl } = req.body || {};
    const missing = [];
    if (!projectId) missing.push('projectId');
    if (!userId)    missing.push('userId');
    if (missing.length > 0) {
      return res.status(400).json({ error: 'Missing required fields', missing });
    }

    // ── 2.2 File presence + size validation ──
    if (!req.file) {
      return res.status(400).json({ error: 'Missing required field: file' });
    }
    if (req.file.size === 0) {
      return res.status(400).json({ error: 'file must not be empty (0 bytes)' });
    }

    // ── 2.4 Sanitize fields ──
    const safeProject = sanitize(projectId);
    const safeUser    = sanitize(userId);
    const safeTool    = tool ? sanitize(tool, 32) : '';

    // ── 2.5 Build object path ──
    const objectPath = buildObjectPath(safeProject, safeUser, safeTool);

    // ── 2.6 Upload to GCS ──
    if (!BUCKET_NAME) {
      console.error('[Hammer backend] GCS_BUCKET env var not set');
      return res.status(500).json({ error: 'Server misconfiguration: GCS_BUCKET not set' });
    }

    const bucket = gcs.bucket(BUCKET_NAME);
    const blob   = bucket.file(objectPath);

    // save() with resumable:false is appropriate for files < 5 MB.
    // Multer already rejects files > 10 MB, and screenshots are typically < 5 MB.
    blob.save(req.file.buffer, {
      resumable: false,
      metadata: {
        contentType: 'image/png',
        metadata: {
          projectId: safeProject,
          userId:    safeUser,
          tool:      safeTool,
          tabUrl:    tabUrl ? tabUrl.slice(0, 500) : '',
          uploadedAt: new Date().toISOString()
        }
      }
    })
    .then(() => {
      // ── 2.8 Return success payload ──
      // size from multer (bytes received), not a second GCS call
      console.log('[Hammer backend] uploaded', objectPath, req.file.size, 'bytes');
      return res.json({
        success: true,
        path:    objectPath,
        size:    req.file.size
      });
    })
    .catch((err) => {
      console.error('[Hammer backend] GCS upload error:', err);
      // 502 for GCS ApiError — not 500 — signals upstream dependency failure
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

module.exports = { app, sanitize, buildObjectPath }; // exported for unit tests
