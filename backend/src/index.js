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
//   POST /admin/projects/:id/storyboards       ← find-or-create a Storyboard draft
//   GET  /admin/storyboards/:id
//   PATCH /admin/storyboards/:id
//   POST  /admin/storyboards/:id/narrative       ← trigger AI narrative generation (#86)
//   PATCH /admin/storyboards/:id/narrative       ← hand-edit the generated narrative (#87)
//   POST  /admin/storyboards/:id/narrative/audio ← transcribe a recording into the prompt (#88)
//   POST  /admin/storyboards/:id/finalize        ← assemble the PDF, create a `reports` doc (#89)
//   POST  /admin/storyboards/:id/video           ← synthesize narration, render via Shotstack (#90)
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
const { getStorage } = require('./lib/storage');
const collections = require('./lib/collections');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Trust proxy — required for Cloud Run rate-limit correctness ──
app.set('trust proxy', 1);

// ── CORS ──────────────────────────────────────────────────────────
// EXTENSION_ID names one or more extensions, and every id that has to reach
// this API needs an origin here. Since #36 that is normally a single id:
// manifest.json declares the public "key" the id is derived from, so every
// unpacked copy on every machine shares one. Before that Chrome derived the id
// from the folder it was loaded from, a list grew one entry per developer
// (#54), and the parsing below is what that list left behind — kept, because
// the reason for it outlives the list: gcloud's --set-env-vars separates
// KEY=VALUE pairs with commas, so a comma inside a value truncates it silently,
// which is why cloudbuild.yaml separates with a space (lesson 63).
// Never '*' — each id stays named.
const EXTENSION_IDS = (process.env.EXTENSION_ID || '')
  .split(/[\s,]+/)
  .filter(Boolean);
const ALLOWED_ORIGINS = [
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : []),
  ...(process.env.ADMIN_ORIGIN ? [process.env.ADMIN_ORIGIN] : []),
  ...EXTENSION_IDS.map((id) => `chrome-extension://${id}`),
];

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Rate limiter: 60 req/IP/min; /health exempt ──────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // Skipped under test, like exportLimiter (middleware/rateLimiters.js), but
  // the argument is stronger here because this one keys on IP: every suite is
  // one caller, and a 429 fails whichever test next reads a field off the
  // error body — not the one that crossed the line. See lessons_learned 85.
  // analystReportLimiter still does not skip; it keys on the caller and
  // encodes a real product limit.
  //
  // cloudbuild.yaml pins NODE_ENV=production on the deployed revision, so this
  // can never be true in production. rate-limit-skip.test.js asserts the
  // limiter still fires when it isn't test.
  skip: () => process.env.NODE_ENV === 'test',
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
const { analystReportLimiter, exportLimiter } = require('./middleware/rateLimiters');

app.use(express.json());

// ── GCS ──────────────────────────────────────────────────────────
const BUCKET_NAME = process.env.GCS_BUCKET;

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

// The tail buildObjectPath() produces: an ISO instant with every separator
// hyphenated, an optional sanitised tool, and two random bytes.
const OBJECT_TAIL_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(_[a-zA-Z0-9_.\-]{1,32})?_[0-9a-f]{4}\.png$/;

// A Capture that fell back to the proxy after /upload-url had already
// recorded it must land on the SAME object path, so the second write updates
// that document instead of creating a twin (the uploads doc id IS the path).
// Otherwise one Capture is two rows, and the first points at bytes that were
// never PUT — which is what an export cannot download.
//
// The path arrives from the client, so it is honoured only where the client
// could already write: under its own project and user prefix, in the exact
// shape buildObjectPath emits. Anything else is ignored rather than refused —
// a fresh path still records the Capture, and rule 4 says never lose one.
function resumableObjectPath(candidate, projectId, userId) {
  if (typeof candidate !== 'string' || candidate.length > 512) return null;
  if (candidate.includes('..')) return null;
  const prefix = `${projectId}/${userId}/`;
  if (!candidate.startsWith(prefix)) return null;
  const tail = candidate.slice(prefix.length);
  return OBJECT_TAIL_RE.test(tail) ? candidate : null;
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
const { loadOwnedProject } = require('./lib/ownership');

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

// multer 2.x listens for 'error', 'aborted' and 'close' on the request and
// surfaces them to the route; 1.x had no such listeners. These are plain Errors
// with no status, so left alone they become a 500 and an ERROR-severity log
// line. A Monitored User closing a laptop lid mid-Capture is an ordinary event
// on the network theHammer runs over, not a server fault, and must not read as
// one in the logs.
const CLIENT_DISCONNECT_MESSAGES = new Set([
  'Request closed',
  'Request aborted',
  'Request error'
]);

function isClientDisconnect(err) {
  return Boolean(err) && CLIENT_DISCONNECT_MESSAGES.has(err.message);
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
const { track: trackPendingWrite } = require('./lib/pendingWrites');

/**
 * Records on the Project when its most recent Capture arrived (#62).
 *
 * The Projects table has a "Last capture" column and a stat tile above it, and
 * both read `lastCaptureAt` off the Project. Nothing ever wrote it, so both read
 * `—` for every Project forever — telling an Admin choosing where to export from
 * that a Project holds no Captures when it holds four (#45's family: the portal
 * reads a property the backend does not send, and `undefined` is falsy rather
 * than an error).
 *
 * Denormalised onto the Project rather than derived at read time. Deriving it
 * means a per-Project query against `uploads` on every list request, and
 * GET /admin/projects returns up to 100 rows — up to 100 extra reads a page, for
 * one column. Same trade ADR 0014 made for `workspaceId`, and the same one
 * `memberCount` already makes.
 *
 * **Never awaited.** AGENTS.md rule 4: nothing may block the capture loop. The
 * `uploads` row is already written by the time this runs, so a failure here
 * costs a stale column, not a lost screenshot; it is logged and dropped.
 *
 * **What it actually times.** The row, not the image. `/upload-url` writes the
 * row before the bytes exist — the extension PUTs them straight to the signed
 * URL and this process never sees them, and nothing reports back when it
 * succeeds. So a Project whose only upload attempts failed carries a stamp,
 * and by CONTEXT.md's language those are Abandoned Uploads, not Captures.
 *
 * That is deliberate, and it is the population `captureCount` already reports:
 * GET /admin/projects/:id counts rows in `uploads` too (#116), for the same
 * reason — nothing distinguishes the two in Firestore, only the presence of the
 * object in GCS does. Stamping only the `/capture` fallback would be narrower
 * and worse: that path is the exception, so most Projects would never be
 * stamped at all and the column would still read `—`. Checking GCS per capture
 * would put a network round trip on the loop rule 4 protects.
 *
 * The honest reading of the column is therefore "when this Project was last
 * worked in", which is what an Admin choosing where to export from wants, and
 * it is stated that way in CONTEXT.md rather than left to the field name
 * (lesson 69).
 *
 * Last write wins, deliberately. Two Captures landing within the same moment
 * can settle out of order and leave the column a few seconds behind; a
 * transaction to prevent that would buy nothing a relative timestamp can show.
 */
function stampLastCapture(projectId, uploadedAt) {
  if (!db || !projectId || !uploadedAt) return Promise.resolve();
  // Registered as in-flight so the test harness can wait for it. Nothing in
  // production reads that register; see src/lib/pendingWrites.js for why an
  // un-awaited write needs one at all.
  return trackPendingWrite(db.collection(collections.PROJECTS).doc(projectId)
    .update({ lastCaptureAt: uploadedAt })
    .catch((err) => {
      logger.error('[hammer-api] lastCaptureAt stamp failed:', {
        projectId, error: err.message,
      });
    }));
}

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
        // The Workspace this Capture belongs to, denormalised off the Project
        // (#102, ADR 0014). `uploads` is counted and listed per Customer, and
        // resolving that through `projectId` means an `in` filter capped at 30
        // Project ids. The value costs no extra read: both callers below have
        // already loaded the Project to prove the caller owns it.
        //
        // Absent means the Capture belongs to nobody, never to whoever asks
        // (lesson 67) — so this must never be allowed to fall back to the
        // caller's own Workspace. It is the Project's, or it is missing and the
        // backfill in scripts/workspace-stamp-backfill.js repairs it.
        workspaceId: fields.workspaceId ?? null,
        userId:     fields.userId,
        tool:       fields.tool,
        // The Persona this Capture was taken in (#63). The extension has always
        // sent it on both upload paths; nothing has ever read it. Firestore
        // rejects undefined, so an absent stage is stored as the empty string.
        stage:      fields.stage ?? '',
        tabUrl:     fields.tabUrl,
        uploadedAt: fields.uploadedAt,
        hasSemanticData: fields.hasSemanticData || false,
        schemaVersion: 1
      },
      { merge: false }
    );
    logger.info('[hammer-api] Firestore write ✓', { doc: docId });

    // Both capture paths write through here, so the Project is stamped once,
    // in one place, whichever route carried the Capture (#62). Not awaited:
    // see stampLastCapture.
    stampLastCapture(fields.projectId, fields.uploadedAt);

    return null;
  } catch (err) {
    logger.error('[hammer-api] Firestore write error:', err);
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
          // Four arguments used to be passed here; the logger takes two, so the
          // blocked URL — the whole point of the entry — was dropped (#106).
          logger.error('[hammer-api] Webhook blocked (SSRF):', { reason: ssrfErr, url: p.webhookUrl });
          return;
        }
        fetch(p.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(err => logger.error('[hammer-api] Webhook dispatch error:', err));
      }
    }
  } catch(err) {
    logger.error('[hammer-api] Webhook fetch project error:', err);
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
    logger.error('[hammer-api] Health check failed:', err);
    res.status(503).json({ status: 'error', reason: 'Firestore disconnected' });
  }
});

// ─ POST /upload-url ───────────────────────────────────────────────
app.post('/upload-url', requireAuth('user'), async (req, res, next) => {
  try {
    const { project, tool, stage, tabUrl } = req.body || {};
    const missing = [];
    if (!project) missing.push('project');
    // `tool` used to be required here and optional on /capture (#66). That one
    // disagreement decided which path a Capture took: an empty Tool box made
    // this route answer 400, the extension fell back to /capture, and only then
    // was the Capture recorded. Filling the box in silently stopped that.
    if (missing.length > 0) return res.status(400).json({ error: 'Missing required fields', missing });
    if (!BUCKET_NAME) return res.status(500).json({ error: 'Server misconfiguration: GCS_BUCKET not set' });

    // Enforce Tenant Isolation. #99: this route's merged answer — unknown and
    // foreign alike — is now what every route family gives (lib/ownership.js).
    //
    // The snapshot is kept rather than discarded (#102): it is the Project whose
    // Workspace the Capture is stamped with below, and it has already been read.
    const projectSnap = await loadOwnedProject(req, res, project);
    if (!projectSnap) return;

    // Mirrors /capture: an absent tool is an empty path segment, not the string
    // "undefined".
    const safeProject = sanitize(project);
    const safeTool    = tool   ? sanitize(tool, 32)   : '';
    const safeStage   = stage  ? sanitize(stage, 32)  : '';
    const safeTabUrl  = tabUrl ? String(tabUrl).slice(0, 500) : '';
    const objectPath  = buildObjectPath(safeProject, req.hammerUser.id, safeTool);

    if (req.body.semanticData) {
      const jsonPath = objectPath.replace(/\.png$/, '.json');
      const jsonFile = getStorage().bucket(BUCKET_NAME).file(jsonPath);
      jsonFile.save(JSON.stringify(req.body.semanticData), {
        contentType: 'application/json'
      }).catch(err => logger.error('[hammer-api] Semantic data write error:', err));
    }

    const file = getStorage().bucket(BUCKET_NAME).file(objectPath);
    const [signedUrl] = await file.getSignedUrl({
      version: 'v4', action: 'write',
      expires: Date.now() + 10 * 60 * 1000,
      contentType: 'image/png'
    });
    const [readUrl] = await file.getSignedUrl({
      version: 'v4', action: 'read',
      expires: Date.now() + 15 * 60 * 1000
    });
    
    // #66: record the Capture here, not only on the /capture fallback.
    //
    // This is the path the extension takes first, and until now it wrote nothing
    // to Firestore. The image reached the bucket and the Activity view, the ZIP
    // export and every report — all of which read `uploads` — never saw it.
    //
    // The document is written before the bytes arrive, because the bytes never
    // come through this process: the extension PUTs them straight to the signed
    // URL. So `size` is whatever the extension declared, and is null when it
    // declared nothing. A row that exists with an unknown size is worth far more
    // than no row at all.
    const firestoreErr = await firestoreWrite(objectPath, {
      path: objectPath, bucket: BUCKET_NAME,
      size: Number.isFinite(Number(req.body?.size)) ? Number(req.body.size) : null,
      projectId: safeProject, workspaceId: projectSnap.data().workspaceId,
      userId: req.hammerUser.id, tool: safeTool,
      stage: safeStage, tabUrl: safeTabUrl,
      uploadedAt: new Date().toISOString(),
      hasSemanticData: !!req.body.semanticData
    });
    // firestoreWrite() returns err.message, so this is a string rather than an
    // Error — named explicitly so it does not read as an unlabelled `detail`.
    if (firestoreErr) logger.error('[hammer-api] upload-url metadata write failed:', { error: firestoreErr });

    dispatchWebhook(safeProject, {
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
      // Every other MulterError is a malformed request: an unexpected field, too
      // many parts, a field name that is too long or nested too deeply. multer 2.x
      // added LIMIT_FIELD_NESTING to that set, and it belongs in this same 400.
      return res.status(400).json({ error: err.message });
    } else if (isClientDisconnect(err)) {
      // The upload ended before it arrived. There may be no socket left to
      // answer on, so say what happened at info level and stop.
      logger.info(`[hammer-api] capture upload ended early: ${err.message}`);
      if (res.headersSent) return;
      return res.status(400).json({ error: 'Upload did not complete' });
    } else if (err) {
      // fileFilter rejections carry their own status; errorHandler honours it.
      return next(err);
    }
    next();
  });
}, async (req, res, next) => {
  try {
    const { projectId, tool, tabUrl, stage } = req.body || {};
    const missing = [];
    if (!projectId) missing.push('projectId');
    if (missing.length > 0) return res.status(400).json({ error: 'Missing required fields', missing });
    if (!req.file)             return res.status(400).json({ error: 'Missing required field: file' });
    if (req.file.size === 0)   return res.status(400).json({ error: 'file must not be empty (0 bytes)' });
    if (!BUCKET_NAME) return res.status(500).json({ error: 'Server misconfiguration: GCS_BUCKET not set' });

    // Enforce Tenant Isolation (#99: lib/ownership.js). The snapshot is kept
    // for the same reason as on /upload-url: it carries the Workspace this
    // Capture is stamped with (#102).
    const projectSnap = await loadOwnedProject(req, res, projectId);
    if (!projectSnap) return;

    const safeProject  = sanitize(projectId);
    const safeUser     = req.hammerUser.id;
    const safeTool     = tool   ? sanitize(tool, 32)    : '';
    const safeStage    = stage  ? sanitize(stage, 32)   : '';
    const safeTabUrl   = tabUrl ? tabUrl.slice(0, 500)  : '';
    // #66 follow-up: resume the path /upload-url already recorded, when the
    // extension is falling back after its PUT failed. Same path, same doc id,
    // so the Capture stays one row.
    const objectPath   = resumableObjectPath(req.body?.resumePath, safeProject, safeUser)
                      ?? buildObjectPath(safeProject, safeUser, safeTool);
    const uploadedAt   = new Date().toISOString();

    const blob = getStorage().bucket(BUCKET_NAME).file(objectPath);
    await blob.save(req.file.buffer, {
      resumable: false,
      metadata: {
        contentType: 'image/png',
        metadata: { projectId: safeProject, userId: safeUser, tool: safeTool, stage: safeStage, tabUrl: safeTabUrl, uploadedAt }
      }
    });

    const hasSemanticData = !!req.body.semanticData;
    if (hasSemanticData) {
      try {
        const parsed = typeof req.body.semanticData === 'string' ? JSON.parse(req.body.semanticData) : req.body.semanticData;
        const jsonPath = objectPath.replace(/\.png$/, '.json');
        const jsonFile = getStorage().bucket(BUCKET_NAME).file(jsonPath);
        jsonFile.save(JSON.stringify(parsed), {
          contentType: 'application/json'
        }).catch(err => logger.error('[hammer-api] Semantic data write error:', err));
      } catch (e) {
        logger.error('[hammer-api] Could not parse semanticData');
      }
    }

    const firestoreErr = await firestoreWrite(objectPath, {
      path: objectPath, bucket: BUCKET_NAME, size: req.file.size,
      projectId: safeProject, workspaceId: projectSnap.data().workspaceId,
      userId: safeUser, tool: safeTool,
      stage: safeStage, tabUrl: safeTabUrl, uploadedAt, hasSemanticData
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

    // Enforce Tenant Isolation (#99: lib/ownership.js)
    if (!await loadOwnedProject(req, res, safeProject)) return;
    
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

    // Enforce Tenant Isolation (#99: lib/ownership.js)
    if (!await loadOwnedProject(req, res, sanitize(body.projectId))) return;

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
app.use('/admin',  require('./routes/admin/exports'));
app.use('/admin',  require('./routes/admin/storyboards'));
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

const { resolveInternalSecret } = require('./lib/internalSecret');

const requireWorkerAuth = (req, res, next) => {
  const secret = req.headers['x-internal-secret'];
  // #105: `|| 'dev-secret'` used to stand here. An unset INTERNAL_SECRET now
  // resolves to null in production, and no presented header equals null, so
  // the internal path refuses everyone rather than accepting a value anyone
  // can read out of this repository.
  const expected = resolveInternalSecret();
  if (expected && secret === expected) {
    // #104: which of the two ways in was taken is what the ownership check
    // below turns on, so it is recorded rather than re-derived there.
    req.isInternalWorker = true;
    return next();
  }
  return requireAdmin(req, res, next);
};

/**
 * #104 — both ends of a worker request belong to the caller, or it is refused.
 *
 * These two routes take a `projectId` and a `reportId` from the body and pass
 * both to report generation. `requireWorkerAuth` accepts the internal secret
 * *or falls back to `requireAdmin`*, so an Admin could name another Customer's
 * Project alongside their own report id and have that Customer's Capture
 * counts, Session timings and Monitored User counts computed and attached to
 * an artifact they own — the worker writes back only `status` and `gcsPath`,
 * never `projectId`, so `GET /admin/reports/:id/status` then answers it
 * normally. Lesson 66 (`reports/generate` taking a projectId on trust) and
 * lesson 67 (a guard added one call site at a time is absent everywhere nobody
 * looked); both routes predate the check existing anywhere.
 *
 * The `reportId` is checked as well as the `projectId`, because the defect
 * mirrors: a Project the caller owns writing into a *foreign* report is the
 * same disclosure run backwards. A report is scoped by the Project it names,
 * so both checks are `loadOwnedProject` and the refusal is the merged one
 * every other Project-scoped route gives — unknown and foreign, at either end,
 * are one answer.
 *
 * The internal-secret path is exempt, and structurally has to be: it is the
 * trusted caller, and carries no `hammerUser` to scope against.
 */
async function workerTargetsAreOwned(req, res) {
  if (req.isInternalWorker) return true;

  const { reportId, projectId } = req.body;
  if (!await loadOwnedProject(req, res, projectId)) return false;

  const reportSnap = reportId
    ? await db.collection(collections.REPORTS).doc(reportId).get()
    : null;
  // A report id naming nothing yields no projectId, which loadOwnedProject
  // refuses with the same answer as a foreign one.
  return !!await loadOwnedProject(req, res, reportSnap?.exists ? reportSnap.data().projectId : null);
}

app.post('/worker/reports', express.json(), workerLimiter, requireWorkerAuth, async (req, res, next) => {
  try {
    if (!await workerTargetsAreOwned(req, res)) return;
    const { reportId, projectId, reportType, dateRange } = req.body;
    generateStandardReport(reportId, projectId, reportType, dateRange);
    res.status(202).send();
  } catch (err) {
    next(err);
  }
});

app.post('/worker/ocr', express.json(), workerLimiter, requireWorkerAuth, async (req, res, next) => {
  try {
    if (!await workerTargetsAreOwned(req, res)) return;
    // #96: a storyboardId, not a dateRange — an OCR Report walks a Storyboard's
    // curated order (ADR 0017). The worker re-checks that the Storyboard
    // belongs to this Project, because requireWorkerAuth also admits an Admin.
    const { reportId, projectId, reportType, storyboardId } = req.body;
    generateOcrReport(reportId, projectId, reportType, storyboardId);
    res.status(202).send();
  } catch (err) {
    next(err);
  }
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
    logger.info(`[hammer-api] EXTENSION_ID=${EXTENSION_IDS.join(', ') || '(not set — CORS for extension disabled)'}`);
  });
}

module.exports = { app, sanitize, buildObjectPath, resumableObjectPath, sha256, rejectOversizedUpload, isClientDisconnect, analystReportLimiter, exportLimiter, stampLastCapture };
