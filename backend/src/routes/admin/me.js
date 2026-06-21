/**
 * Sprint 5.13  —  GET /me
 * Sprint 5.8b  —  GET /me/projects
 * Sprint 5.8c  —  GET /config
 * Sprint 5.12b —  PATCH /config  (Global Settings panel save)
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
 *             401 { error: 'missing or invalid API key' }
 *
 * PATCH /config
 *   Updates global extension settings. Admin-only (requireAdmin / IAP).
 *   Accepts a partial body; only known fields are written (no passthrough).
 *   Response: 200 { retentionDays, maxFileSizeBytes, defaultCaptureQuality, backendUrl, schemaVersion }
 *             400 { error, field, value } on validation failure
 *             401/403 on auth failure
 *
 * Mounted at app.use('/', router) so paths are /me, /me/projects, /config.
 */

'use strict';

const crypto   = require('crypto');
const express  = require('express');
const { Timestamp } = require('firebase-admin/firestore');
const { db }   = require('../../lib/firestore');
const { requireAuth, requireAdmin } = require('../../middleware/requireAuth');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function sha256hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// ─────────────────────────────────────────────────────────────────
// GET /me  —  Sprint 5.13 / Sprint 20
// ─────────────────────────────────────────────────────────────────

router.get('/me', requireAuth('user'), async (req, res, next) => {
  try {
    const d = req.hammerUser;
    return res.json({
      id:          d.id,
      uid:         d.uid,
      email:       d.email,
      displayName: d.displayName ?? null,
      role:        d.role,
      workspaceId: d.workspaceId,
      provisioned: true,
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

router.get('/me/projects', requireAuth('user'), async (req, res, next) => {
  try {
    const userId = req.hammerUser.id;

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
// Admins write this config via PATCH /config (task 5.12b).
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

const VALID_CAPTURE_QUALITY = ['png', 'webp'];

function readConfig(d) {
  return {
    retentionDays:         d.retentionDays         ?? CONFIG_DEFAULTS.retentionDays,
    maxFileSizeBytes:      d.maxFileSizeBytes       ?? CONFIG_DEFAULTS.maxFileSizeBytes,
    defaultCaptureQuality: d.defaultCaptureQuality  ?? CONFIG_DEFAULTS.defaultCaptureQuality,
    backendUrl:            d.backendUrl             ?? CONFIG_DEFAULTS.backendUrl,
    inactivityPromptEnabled: d.inactivityPromptEnabled ?? false,
    allowPreUploadBlur: d.allowPreUploadBlur ?? false,
    instantClipboardLinks: d.instantClipboardLinks ?? false,
    schemaVersion:         d.schemaVersion          ?? 1,
  };
}

router.get('/config', requireAuth('user'), async (req, res, next) => {
  try {
    const snap = await db.collection('config').doc('global').get();

    let configData = { ...CONFIG_DEFAULTS, inactivityPromptEnabled: false, allowPreUploadBlur: false, instantClipboardLinks: false };
    if (snap.exists) {
      configData = readConfig(snap.data());
    }

    // Per-user entitlement overrides global entitlement if it is explicitly set
    const userData = req.hammerUser;
    if (typeof userData.inactivityPromptEnabled === 'boolean') {
      configData.inactivityPromptEnabled = userData.inactivityPromptEnabled;
    }
    if (typeof userData.inactivityTimerSeconds === 'number') {
      configData.inactivityTimerSeconds = userData.inactivityTimerSeconds;
    }
    if (typeof userData.allowPreUploadBlur === 'boolean') {
      configData.allowPreUploadBlur = userData.allowPreUploadBlur;
    }
    if (typeof userData.instantClipboardLinks === 'boolean') {
      configData.instantClipboardLinks = userData.instantClipboardLinks;
    }

    if (!snap.exists) {
      return res.json({ ...configData, _source: 'defaults' });
    }

    return res.json(configData);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────
// PATCH /config  —  Sprint 5.12b
// Admin-only. Partial updates are safe — only known fields are written.
// Uses Firestore set({ merge: true }) so missing body fields are preserved.
// ─────────────────────────────────────────────────────────────────

router.patch('/config', requireAdmin, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const update = {};

    // retentionDays — positive integer
    if ('retentionDays' in body) {
      const v = parseInt(body.retentionDays, 10);
      if (!Number.isFinite(v) || v < 1) {
        return res.status(400).json({ error: 'retentionDays must be a positive integer', field: 'retentionDays', value: body.retentionDays });
      }
      update.retentionDays = v;
    }

    // maxFileSizeBytes — positive integer, max 100 MB
    if ('maxFileSizeBytes' in body) {
      const v = parseInt(body.maxFileSizeBytes, 10);
      if (!Number.isFinite(v) || v < 1 || v > 100 * 1024 * 1024) {
        return res.status(400).json({ error: 'maxFileSizeBytes must be between 1 and 104857600', field: 'maxFileSizeBytes', value: body.maxFileSizeBytes });
      }
      update.maxFileSizeBytes = v;
    }

    // defaultCaptureQuality — 'png' | 'webp'
    if ('defaultCaptureQuality' in body) {
      if (!VALID_CAPTURE_QUALITY.includes(body.defaultCaptureQuality)) {
        return res.status(400).json({ error: `defaultCaptureQuality must be one of: ${VALID_CAPTURE_QUALITY.join(', ')}`, field: 'defaultCaptureQuality', value: body.defaultCaptureQuality });
      }
      update.defaultCaptureQuality = body.defaultCaptureQuality;
    }

    // backendUrl — non-empty string
    if ('backendUrl' in body) {
      const v = (body.backendUrl ?? '').trim();
      if (!v || !/^https?:\/\/.+/.test(v)) {
        return res.status(400).json({ error: 'backendUrl must be a valid http/https URL', field: 'backendUrl', value: body.backendUrl });
      }
      update.backendUrl = v;
    }

    // inactivityPromptEnabled — boolean
    if ('inactivityPromptEnabled' in body) {
      update.inactivityPromptEnabled = !!body.inactivityPromptEnabled;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'no valid fields provided' });
    }

    update.schemaVersion = 1;
    update.updatedAt     = new Date().toISOString();
    update.updatedBy     = req.hammerUser?.id ?? null;

    const ref = db.collection('config').doc('global');
    await ref.set(update, { merge: true });

    const saved = await ref.get();
    return res.json(readConfig(saved.data()));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
