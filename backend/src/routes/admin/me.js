/**
 * Sprint 5.13  —  GET /me
 * Sprint 5.8b  —  GET /me/projects
 * Sprint 5.8c  —  GET /config
 *
 * GET /me
 *   Identity endpoint for the Admin Portal SPA auth gate (IAP identity).
 *   Response: 200 { id, email, displayName, role, provisioned, lastActiveAt }
 *             403 { error: 'not provisioned', email }
 *             401 { error: 'unauthenticated' }
 *
 * GET /me/projects
 *   Returns the list of projects the caller is a member of.
 *   Auth: X-Api-Key header resolved against Firestore api_keys collection.
 *   Response: 200 { projects: [...], total }
 *             401 { error: 'missing or invalid API key' }
 *
 * GET /config
 *   Returns global extension settings stored in Firestore config/global doc.
 *   Auth: X-Api-Key (any valid key holder may read config).
 *   Response: 200 { retentionDays, maxFileSizeBytes, defaultCaptureQuality, ... }
 *             404 { error: 'config not found' }
 *             401 { error: 'missing or invalid API key' }
 *
 * Mounted at app.use('/', router) so paths are /me, /me/projects, /config.
 */

'use strict';

const crypto   = require('crypto');
const express  = require('express');
const { Timestamp } = require('firebase-admin/firestore');
const { db }   = require('../../lib/firestore');
const { extractIAPEmail } = require('../../middleware/requireAdmin');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function sha256hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Resolve an X-Api-Key header to a Firestore user record.
 * Looks up sha256(key) in the api_keys collection (isActive == true).
 * Returns the user Firestore document snapshot, or null if not found/invalid.
 *
 * NOTE: The full role-aware api-key middleware lands in Sprint 9 (task 9.2).
 * This inline lookup is intentionally minimal — it only resolves the userId
 * so we can query project_memberships. No role assertion is made here.
 */
async function resolveApiKeyUser(req) {
  const raw = req.headers['x-api-key'];
  if (!raw || typeof raw !== 'string') return null;

  const keyHash = sha256hex(raw);
  const keySnap = await db.collection('api_keys')
    .where('keyHash', '==', keyHash)
    .where('isActive', '==', true)
    .limit(1)
    .get();

  if (keySnap.empty) return null;

  const keyDoc = keySnap.docs[0].data();
  const userSnap = await db.collection('users').doc(keyDoc.userId).get();
  return userSnap.exists ? userSnap : null;
}

// ─────────────────────────────────────────────────────────────────
// GET /me  —  Sprint 5.13
// ─────────────────────────────────────────────────────────────────

router.get('/me', async (req, res, next) => {
  try {
    const email = extractIAPEmail(req);
    if (!email) {
      return res.status(401).json({ error: 'unauthenticated' });
    }

    const snap = await db.collection('users')
      .where('email', '==', email.toLowerCase())
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(403).json({ error: 'not provisioned', email });
    }

    const doc = snap.docs[0];
    const d   = doc.data();
    return res.json({
      id:          doc.id,
      email:       d.email,
      displayName: d.displayName ?? null,
      role:        d.role,
      provisioned: true,
      lastActiveAt: d.lastActiveAt instanceof Timestamp
        ? d.lastActiveAt.toDate().toISOString()
        : d.lastActiveAt ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /me/projects  —  Sprint 5.8b
// Resolves identity from X-Api-Key; returns only projects the caller
// is a member of, ordered by project name ascending.
// ─────────────────────────────────────────────────────────────────

router.get('/me/projects', async (req, res, next) => {
  try {
    const userSnap = await resolveApiKeyUser(req);
    if (!userSnap) {
      return res.status(401).json({ error: 'missing or invalid API key' });
    }

    const userId = userSnap.id;

    // Fetch all memberships for this user
    const membSnap = await db.collection('project_memberships')
      .where('userId', '==', userId)
      .get();

    if (membSnap.empty) {
      return res.json({ projects: [], total: 0 });
    }

    // Batch-fetch all project docs in a single getAll RPC
    const projectIds = membSnap.docs.map(d => d.data().projectId);
    const projectRefs = [...new Set(projectIds)].map(id =>
      db.collection('projects').doc(id)
    );
    const projectSnaps = await db.getAll(...projectRefs);

    // Build a role-annotated response keyed by project
    const roleByProject = {};
    membSnap.docs.forEach(d => {
      const data = d.data();
      roleByProject[data.projectId] = data.role;
    });

    const projects = projectSnaps
      .filter(s => s.exists)
      .map(s => {
        const d = s.data();
        return {
          id:          s.id,
          name:        d.name,
          memberCount: d.memberCount ?? 0,
          status:      d.status ?? 'active',
          role:        roleByProject[s.id] ?? null,
          createdAt:   d.createdAt instanceof Timestamp
                         ? d.createdAt.toDate().toISOString()
                         : d.createdAt,
          schemaVersion: d.schemaVersion,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.json({ projects, total: projects.length });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /config  —  Sprint 5.8c
// Returns global extension settings from Firestore config/global.
// Readable by any holder of a valid API key (all roles).
// Admins write this config via the Global Settings panel (task 5.12b).
//
// Firestore path: config/global
// Fields (with safe defaults if doc is missing individual keys):
//   retentionDays        number   — how long GCS screenshots are kept
//   maxFileSizeBytes     number   — upload size ceiling enforced by backend
//   defaultCaptureQuality string  — 'png' | 'webp'
//   backendUrl           string   — canonical API base URL
//   schemaVersion        number
// ─────────────────────────────────────────────────────────────────

const CONFIG_DEFAULTS = {
  retentionDays:         365,
  maxFileSizeBytes:      10 * 1024 * 1024, // 10 MB
  defaultCaptureQuality: 'png',
  backendUrl:            'https://app.thehammer.io/api',
  schemaVersion:         1,
};

router.get('/config', async (req, res, next) => {
  try {
    const userSnap = await resolveApiKeyUser(req);
    if (!userSnap) {
      return res.status(401).json({ error: 'missing or invalid API key' });
    }

    const snap = await db.collection('config').doc('global').get();

    if (!snap.exists) {
      // Return safe defaults — the admin hasn't saved a config doc yet.
      // This is not a 404: the extension must always be able to boot.
      return res.json({ ...CONFIG_DEFAULTS, _source: 'defaults' });
    }

    const d = snap.data();
    return res.json({
      retentionDays:         d.retentionDays         ?? CONFIG_DEFAULTS.retentionDays,
      maxFileSizeBytes:      d.maxFileSizeBytes       ?? CONFIG_DEFAULTS.maxFileSizeBytes,
      defaultCaptureQuality: d.defaultCaptureQuality  ?? CONFIG_DEFAULTS.defaultCaptureQuality,
      backendUrl:            d.backendUrl             ?? CONFIG_DEFAULTS.backendUrl,
      schemaVersion:         d.schemaVersion          ?? 1,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
