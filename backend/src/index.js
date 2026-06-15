// ─────────────────────────────────────────────────────────────────
// The Hammer — Backend (Sprint 2, fixes applied per lessons_learned.md)
// POST /capture   → Content-Type guard → auth → multer → validate → sanitize → GCS
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
// Item 3 fix (lessons_learned.md): HMAC-based constant-time key comparison.
// Both sides are hashed to a fixed 32-byte digest before timingSafeEqual
// so neither the comparison nor the length check leaks key length info.
// NEVER split this into timingSafeEqual(...) && length === length —
// the separate length check runs in non-constant time and narrows brute-force space.
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
// 2.7 — API key auth middleware
// Key comes from Secret Manager via Cloud Run --set-secrets.
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
// Items 2+5 fix (lessons_learned.md): pre-multer Content-Type guard.
// Rejects non-multipart requests immediately — before multer buffers
// anything — satisfying the spec constraint from task 2.3.
//
// NOTE: We cannot read body *fields* before multer (multipart fields
// arrive interleaved with the binary data in the stream). What we CAN
// do pre-multer is reject obviously wrong requests by Content-Type.
// Full field validation (projectId, userId) still runs post-multer;
// that tradeoff is intentional and documented here so no future reader
// thinks the post-multer check is an oversight.
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
// 2.4 — Sanitize a string field
// • Strips null bytes and path-traversal sequences (../ and ..\)
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
// Format: {projectId}/{userId}/{YYYY-MM-DDTHH-MM-SS-mmmZ}_{tool}_{rand4}.png
// 4-char random hex suffix ensures two captures in the same millisecond
// produce different paths.
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
// Middleware order:
//   1. requireApiKey      — fast 401 before any body parsing
//   2. requireMultipart   — fast 400 before multer streams the body (item 2+5 fix)
//   3. upload.single      — streams + buffers the file
//   4. handler            — post-multer field validation, sanitize, GCS upload
app.post(
  '/capture',
  requireApiKey,
  requireMultipart,
  upload.single('file'),
  (req, res) => {
    // ── 2.3 Post-multer field validation ──
    // (Pre-multer field validation is impossible for multipart — see requireMultipart comment)
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
    // Multer rejects > 10 MB; screenshots are typically < 5 MB.
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
