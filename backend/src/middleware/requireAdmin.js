/**
 * requireRole(minRole) — parameterized auth middleware  —  Sprint 5.2–5.8+
 *
 * Execution order:
 *   1. Extract email from X-Goog-Authenticated-User-Email (Cloud IAP).
 *      In local dev / test (NODE_ENV !== 'production'), falls back to
 *      X-Dev-User-Email so you can test without IAP.
 *   2. Look up the email in Firestore users collection.
 *   3. Confirm user.role meets the minimum required level.
 *   4. Attach req.hammerUser = { id, email, role, displayName } for downstream handlers.
 *
 * Errors:
 *   401 — IAP header missing
 *   403 — user not in Firestore OR role below minimum
 *
 * Exports:
 *   requireRole(minRole)  — factory; returns Express middleware
 *   requireAdmin          — convenience alias for requireRole('admin')
 *   extractIAPEmail(req)  — used by /me route
 */

'use strict';

const { db } = require('../lib/firestore');

const ROLE_HIERARCHY = { admin: 4, analyst: 3, instructional_designer: 2, user: 1 };

/**
 * Pulls the caller email from the IAP header.
 * Returns lowercase string or null.
 */
function extractIAPEmail(req) {
  const iapHeader = req.headers['x-goog-authenticated-user-email'];
  if (iapHeader) {
    const parts = iapHeader.split(':');
    return parts[parts.length - 1].trim().toLowerCase();
  }
  // Local dev / test fallback — never present in Cloud Run production
  if (process.env.NODE_ENV !== 'production') {
    const devHeader = req.headers['x-dev-user-email'];
    if (devHeader) return devHeader.trim().toLowerCase();
  }
  return null;
}

/**
 * requireRole(minRole) — returns middleware that enforces minimum role.
 * minRole must be one of: 'admin' | 'analyst' | 'instructional_designer' | 'user'
 */
function requireRole(minRole) {
  return async (req, res, next) => {
    const email = extractIAPEmail(req);
    if (!email) {
      return res.status(401).json({ error: 'unauthenticated' });
    }

    try {
      const snap = await db.collection('users')
        .where('email', '==', email)
        .limit(1)
        .get();

      if (snap.empty) {
        return res.status(403).json({ error: 'not provisioned', email });
      }

      const doc  = snap.docs[0];
      const d    = doc.data();
      const userLevel = ROLE_HIERARCHY[d.role]  ?? 0;
      const minLevel  = ROLE_HIERARCHY[minRole] ?? 99;

      if (userLevel < minLevel) {
        return res.status(403).json({
          error:    'forbidden: insufficient role',
          required: minRole,
          actual:   d.role,
        });
      }

      req.hammerUser = {
        id:          doc.id,
        email:       d.email,
        role:        d.role,
        displayName: d.displayName ?? null,
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}

// Convenience aliases
const requireAdmin = requireRole('admin');

module.exports = { requireRole, requireAdmin, extractIAPEmail };
