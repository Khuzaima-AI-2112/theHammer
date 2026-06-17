/**
 * requireAdmin middleware  —  Sprint 5.2–5.8
 *
 * Execution order:
 *   1. Extract email from X-Goog-Authenticated-User-Email (Cloud IAP).
 *      In local dev (NODE_ENV !== 'production'), falls back to
 *      X-Dev-User-Email so you can test without IAP.
 *   2. Look up the email in Firestore users collection.
 *   3. Confirm role === 'admin'.
 *   4. Attach req.hammerUser = { id, email, role, displayName } for downstream handlers.
 *
 * Errors:
 *   401 — header missing
 *   403 — user not in Firestore OR role !== 'admin'
 *
 * Also exports extractIAPEmail() for use by /admin/me (non-admin route).
 */

'use strict';

const { db } = require('../lib/firestore');

/**
 * Pulls the caller email from the IAP header.
 * Returns lowercase string or null.
 */
function extractIAPEmail(req) {
  // IAP sets:  X-Goog-Authenticated-User-Email: accounts.google.com:user@domain.com
  const iapHeader = req.headers['x-goog-authenticated-user-email'];
  if (iapHeader) {
    const parts = iapHeader.split(':');
    return parts[parts.length - 1].toLowerCase();
  }
  // Local dev fallback (never present in Cloud Run production)
  if (process.env.NODE_ENV !== 'production') {
    const devHeader = req.headers['x-dev-user-email'];
    if (devHeader) return devHeader.toLowerCase();
  }
  return null;
}

async function requireAdmin(req, res, next) {
  const email = extractIAPEmail(req);
  if (!email) {
    return res.status(401).json({ error: 'unauthenticated' });
  }

  const snap = await db.collection('users')
    .where('email', '==', email)
    .limit(1)
    .get();

  if (snap.empty) {
    return res.status(403).json({ error: 'not provisioned', email });
  }

  const doc = snap.docs[0];
  const d   = doc.data();

  if (d.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden: admin role required', role: d.role });
  }

  req.hammerUser = {
    id:          doc.id,
    email:       d.email,
    role:        d.role,
    displayName: d.displayName ?? null,
  };

  next();
}

module.exports = { requireAdmin, extractIAPEmail };
