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
// ─────────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { Storage } = require('@google-cloud/storage');
const { Firestore, FieldValue } = require('@google-cloud/firestore');

const app = express();
const PORT = process.env.PORT || 8080;

// ── Trust proxy — required for Cloud Run rate-limit correctness ──
app.set('trust proxy', 1);

// ── CORS — arch decision: *.run.app for now; app.thehammer.io deferred to Sprint 21 ──
const EXTENSION_ID = process.env.EXTENSION_ID || '';
const ALLOWED_ORIGINS = [
  // Sprint 21: swap to https://app.thehammer.io once HTTPS LB is live
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

// ── Rate limiter: 60 req/IP/min; /health exempt ──
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

// ── GCS ──
const BUCKET_NAME = process.env.GCS_BUCKET;
const gcs = new Storage();

// ── Firestore ──
const FIRESTORE_ENABLED = process.env.FIRESTORE_ENABLED !== 'false';
const db = FIRESTORE_ENABLED ? new Firestore() : null;

// ── Role hierarchy ──
const ROLE_HIERARCHY = { admin: 4, analyst: 3, instructional_designer: 2, user: 1 };

// ── Multer (memory storage, 10 MB) ──
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
  const ts = now.toISOString().replace(/:/g, '-').replace(/\./g, '-');
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

/**
 * requireRole — reads IAP header, looks up user in Firestore, enforces ROLE_HIERARCHY.
 * arch_decisions.md Final Call 3A: Cloud IAP injects X-Goog-Authenticated-User-Email.
 * No custom session code; no Firebase Auth.
 *
 * Sprint 21: when HTTPS LB + IAP are live this header is guaranteed on all non-health
 * requests. During Sprint 5 dev on *.run.app, tests inject the header via supertest.
 */
function requireRole(minRole) {
  return async (req, res, next) => {
    const rawEmail = req.headers['x-goog-authenticated-user-email'] || '';
    const email = rawEmail.replace('accounts.google.com:', '').trim();
    if (!email) return res.status(401).json({ error: 'IAP identity required' });
    if (!db) return res.status(503).json({ error: 'Firestore not available' });

    try {
      const snap = await db.collection('users')
        .where('email', '==', email)
        .limit(1)
        .get();
      if (snap.empty) return res.status(403).json({ error: 'User not provisioned' });

      const doc = snap.docs[0];
      const user = doc.data();
      const userLevel = ROLE_HIERARCHY[user.role] ?? 0;
      const minLevel = ROLE_HIERARCHY[minRole] ?? 99;

      if (userLevel < minLevel) {
        return res.status(403).json({ error: 'Insufficient role', required: minRole, actual: user.role });
      }

      req.user = { email, role: user.role, userId: doc.id };
      next();
    } catch (err) {
      console.error('[hammer-api] requireRole error:', err.message);
      return res.status(500).json({ error: 'Auth lookup failed' });
    }
  };
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
// Firestore helpers
// ─────────────────────────────────────────────────────────────────

async function firestoreWrite(objectPath, fields) {
  if (!db) return;
  try {
    const docId = encodeURIComponent(objectPath);
    await db.collection('uploads').doc(docId).set(
      {
        path: fields.path,
        bucket: fields.bucket,
        size: fields.size,
        projectId: fields.projectId,
        userId: fields.userId,
        tool: fields.tool,
        tabUrl: fields.tabUrl,
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
// Routes
// ─────────────────────────────────────────────────────────────────

// ─ Health ─────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─ GET /me ────────────────────────────────────────────────────────
// Identity shim for the Admin Portal SPA.
// Reads the IAP header and returns the resolved email + Firestore role.
// The SPA calls this once on boot to populate the topbar user chip.
// No role gate: any valid IAP identity can call /me; the role is returned
// in the payload so the SPA can conditionally render admin-only UI.
// 401 when IAP header is absent (direct *.run.app call without IAP tunnel).
app.get('/me', async (req, res) => {
  const rawEmail = req.headers['x-goog-authenticated-user-email'] || '';
  const email = rawEmail.replace('accounts.google.com:', '').trim();
  if (!email) return res.status(401).json({ error: 'IAP identity required' });
  if (!db) return res.json({ email, role: null }); // Firestore disabled: return bare identity

  try {
    const snap = await db.collection('users')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (snap.empty) {
      // User authenticated by IAP but not yet provisioned in Firestore.
      // Return 200 with role:null so the SPA can show a "not yet provisioned" state
      // rather than crashing. The admin can provision them via POST /admin/users
      // (Sprint 6).
      return res.json({ email, role: null, provisioned: false });
    }

    const user = snap.docs[0].data();
    return res.json({
      email,
      role: user.role,
      displayName: user.displayName || null,
      userId: snap.docs[0].id,
      provisioned: true
    });
  } catch (err) {
    console.error('[hammer-api] /me error:', err.message);
    return res.status(500).json({ error: 'Identity lookup failed' });
  }
});

// ─ POST /upload-url (Sprint 4) ────────────────────────────────────
app.post('/upload-url', requireApiKey, async (req, res) => {
  const { project, tool, name } = req.body || {};
  const missing = [];
  if (!project) missing.push('project');
  if (!tool) missing.push('tool');
  if (!name) missing.push('name');
  if (missing.length > 0) return res.status(400).json({ error: 'Missing required fields', missing });
  if (!BUCKET_NAME) return res.status(500).json({ error: 'Server misconfiguration: GCS_BUCKET not set' });

  const objectPath = buildObjectPath(sanitize(project), sanitize(name), sanitize(tool, 32));
  try {
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

// ─ POST /capture (Sprint 4) ───────────────────────────────────────
app.post('/capture', requireApiKey, requireMultipart, upload.single('file'), async (req, res) => {
  const { projectId, userId, tool, tabUrl } = req.body || {};
  const missing = [];
  if (!projectId) missing.push('projectId');
  if (!userId) missing.push('userId');
  if (missing.length > 0) return res.status(400).json({ error: 'Missing required fields', missing });
  if (!req.file) return res.status(400).json({ error: 'Missing required field: file' });
  if (req.file.size === 0) return res.status(400).json({ error: 'file must not be empty (0 bytes)' });
  if (!BUCKET_NAME) return res.status(500).json({ error: 'Server misconfiguration: GCS_BUCKET not set' });

  const safeProject = sanitize(projectId);
  const safeUser = sanitize(userId);
  const safeTool = tool ? sanitize(tool, 32) : '';
  const safeTabUrl = tabUrl ? tabUrl.slice(0, 500) : '';
  const objectPath = buildObjectPath(safeProject, safeUser, safeTool);
  const uploadedAt = new Date().toISOString();

  const blob = gcs.bucket(BUCKET_NAME).file(objectPath);
  try {
    await blob.save(req.file.buffer, {
      resumable: false,
      metadata: {
        contentType: 'image/png',
        metadata: { projectId: safeProject, userId: safeUser, tool: safeTool, tabUrl: safeTabUrl, uploadedAt }
      }
    });
  } catch (err) {
    return res.status(502).json({ error: 'GCS upload failed', detail: err.message });
  }

  await firestoreWrite(objectPath, {
    path: objectPath, bucket: BUCKET_NAME, size: req.file.size,
    projectId: safeProject, userId: safeUser, tool: safeTool,
    tabUrl: safeTabUrl, uploadedAt
  });

  return res.json({ success: true, path: objectPath, size: req.file.size });
});

// ─────────────────────────────────────────────────────────────────
// Admin CRUD routes (Sprint 5: 5.2–5.8)
// All routes protected by requireRole('admin')
// ─────────────────────────────────────────────────────────────────

// 5.2 — POST /admin/projects
app.post('/admin/projects', requireRole('admin'), async (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!db) return res.status(503).json({ error: 'Firestore not available' });

  const now = new Date().toISOString();
  const projectRef = db.collection('projects').doc();
  const projectId = projectRef.id;

  await projectRef.set({
    name: name.trim().slice(0, 128),
    adminId: req.user.userId,
    memberCount: 0,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  });

  return res.status(201).json({ projectId, name: name.trim().slice(0, 128), createdAt: now });
});

// 5.3 — GET /admin/projects
app.get('/admin/projects', requireRole('admin'), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Firestore not available' });

  const snap = await db.collection('projects')
    .orderBy('createdAt', 'desc')
    .get();

  const projects = snap.docs.map(doc => ({ projectId: doc.id, ...doc.data() }));
  return res.json(projects);
});

// 5.4 — GET /admin/projects/:id
app.get('/admin/projects/:id', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  if (!db) return res.status(503).json({ error: 'Firestore not available' });

  const snap = await db.collection('projects').doc(id).get();
  if (!snap.exists) return res.status(404).json({ error: 'Project not found' });

  return res.json({ projectId: snap.id, ...snap.data() });
});

// 5.5 — PATCH /admin/projects/:id
app.patch('/admin/projects/:id', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  if (!db) return res.status(503).json({ error: 'Firestore not available' });

  const ref = db.collection('projects').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'Project not found' });

  const allowed = ['name'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      if (key === 'name') {
        const trimmed = String(req.body[key]).trim().slice(0, 128);
        if (trimmed) updates[key] = trimmed;
      } else {
        updates[key] = req.body[key];
      }
    }
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }
  updates.updatedAt = new Date().toISOString();

  await ref.update(updates);
  return res.json({ projectId: id, ...updates });
});

// 5.6 — DELETE /admin/projects/:id
// Batched write: project doc + all project_memberships where projectId == id.
app.delete('/admin/projects/:id', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  if (!db) return res.status(503).json({ error: 'Firestore not available' });

  const projectRef = db.collection('projects').doc(id);
  const projectSnap = await projectRef.get();
  if (!projectSnap.exists) return res.status(404).json({ error: 'Project not found' });

  const memberships = await db.collection('project_memberships')
    .where('projectId', '==', id)
    .get();

  const batch = db.batch();
  batch.delete(projectRef);
  for (const doc of memberships.docs) batch.delete(doc.ref);
  await batch.commit();

  return res.sendStatus(204);
});

// 5.7 — POST /admin/projects/:id/members
// Transaction: atomically write membership doc + increment project.memberCount.
app.post('/admin/projects/:id/members', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { userId, role } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  if (!role || !ROLE_HIERARCHY[role]) {
    return res.status(400).json({ error: 'role is required and must be a valid role' });
  }
  if (!db) return res.status(503).json({ error: 'Firestore not available' });

  const projectRef = db.collection('projects').doc(id);
  const membershipId = `${id}_${userId}`;
  const membershipRef = db.collection('project_memberships').doc(membershipId);

  try {
    await db.runTransaction(async (tx) => {
      const projectSnap = await tx.get(projectRef);
      if (!projectSnap.exists) throw Object.assign(new Error('Project not found'), { status: 404 });

      const userSnap = await tx.get(db.collection('users').doc(userId));
      if (!userSnap.exists) throw Object.assign(new Error('User not found'), { status: 404 });

      const memberSnap = await tx.get(membershipRef);
      if (memberSnap.exists) throw Object.assign(new Error('User already a member'), { status: 409 });

      const now = new Date().toISOString();
      tx.set(membershipRef, {
        projectId: id,
        userId,
        role,
        admittedAt: now,
        admittedBy: req.user.userId,
        schemaVersion: 1
      });
      tx.update(projectRef, { memberCount: FieldValue.increment(1), updatedAt: now });
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  return res.status(201).json({ projectId: id, userId, role });
});

// 5.8 — DELETE /admin/projects/:id/members/:userId
// Transaction: delete membership doc + decrement project.memberCount.
app.delete('/admin/projects/:id/members/:userId', requireRole('admin'), async (req, res) => {
  const { id, userId } = req.params;
  if (!db) return res.status(503).json({ error: 'Firestore not available' });

  const projectRef = db.collection('projects').doc(id);
  const membershipRef = db.collection('project_memberships').doc(`${id}_${userId}`);

  try {
    await db.runTransaction(async (tx) => {
      const projectSnap = await tx.get(projectRef);
      if (!projectSnap.exists) throw Object.assign(new Error('Project not found'), { status: 404 });

      const memberSnap = await tx.get(membershipRef);
      if (!memberSnap.exists) throw Object.assign(new Error('Membership not found'), { status: 404 });

      const now = new Date().toISOString();
      tx.delete(membershipRef);
      tx.update(projectRef, { memberCount: FieldValue.increment(-1), updatedAt: now });
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  return res.sendStatus(204);
});

// 5.9 — GET /admin/projects/:id/activity
// Returns last 100 uploads for the project; ?tool= filter uses composite index.
app.get('/admin/projects/:id/activity', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { tool } = req.query;
  if (!db) return res.status(503).json({ error: 'Firestore not available' });

  let query = db.collection('uploads')
    .where('projectId', '==', id)
    .orderBy('uploadedAt', 'desc')
    .limit(100);

  if (tool && typeof tool === 'string' && tool.trim()) {
    query = db.collection('uploads')
      .where('projectId', '==', id)
      .where('tool', '==', tool.trim())
      .orderBy('uploadedAt', 'desc')
      .limit(100);
  }

  const snap = await query.get();
  const uploads = snap.docs.map(doc => ({ uploadId: doc.id, ...doc.data() }));
  return res.json(uploads);
});

// ─────────────────────────────────────────────────────────────────
// Admin Users routes (Sprint 5: 5.10)
// ─────────────────────────────────────────────────────────────────

// GET /admin/users
// Returns all users ordered by createdAt desc.
// Optional ?role= filter narrows to a specific role.
// Optional ?projectId= filter returns only users who are members of that project
// by joining project_memberships (two Firestore reads, no composite index needed).
app.get('/admin/users', requireRole('admin'), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Firestore not available' });

  const { role, projectId } = req.query;

  // projectId filter: fetch memberships first, then fetch each user by ID.
  if (projectId && typeof projectId === 'string' && projectId.trim()) {
    const memberSnap = await db.collection('project_memberships')
      .where('projectId', '==', projectId.trim())
      .orderBy('admittedAt', 'desc')
      .get();

    const users = await Promise.all(
      memberSnap.docs.map(async (m) => {
        const mData = m.data();
        const userSnap = await db.collection('users').doc(mData.userId).get();
        if (!userSnap.exists) return null;
        return {
          userId: mData.userId,
          ...userSnap.data(),
          membership: {
            role: mData.role,
            admittedAt: mData.admittedAt,
            admittedBy: mData.admittedBy
          }
        };
      })
    );

    return res.json(users.filter(Boolean));
  }

  // No projectId: list all users, optional role filter.
  let query = db.collection('users').orderBy('createdAt', 'desc');
  // Note: role filter requires a single-field index on (role, createdAt).
  // For Sprint 5, we filter in memory to avoid an index deploy gate.
  const snap = await query.get();
  let users = snap.docs.map(doc => ({ userId: doc.id, ...doc.data() }));
  if (role && ROLE_HIERARCHY[role]) {
    users = users.filter(u => u.role === role);
  }
  return res.json(users);
});

// GET /admin/users/:id
// Fetch a single user by Firestore document ID.
app.get('/admin/users/:id', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  if (!db) return res.status(503).json({ error: 'Firestore not available' });

  const snap = await db.collection('users').doc(id).get();
  if (!snap.exists) return res.status(404).json({ error: 'User not found' });

  return res.json({ userId: snap.id, ...snap.data() });
});

// ─ Admin Users Router (Sprint 5) ──────────────────────────────────
app.use('/admin', require('./routes/admin/users'));

// ─ 404 fallback ───────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─ Start ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[hammer-api] listening on :${PORT}`);
  console.log(`[hammer-api] GCS_BUCKET=${BUCKET_NAME || '(not set)'}`);
  console.log(`[hammer-api] Firestore=${FIRESTORE_ENABLED ? 'enabled' : 'disabled'}`);
  console.log(`[hammer-api] EXTENSION_ID=${EXTENSION_ID || '(not set — CORS for extension disabled)'}`);
});

module.exports = { app, sanitize, buildObjectPath, sha256 };
