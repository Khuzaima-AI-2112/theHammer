/**
 * requireAuth(minRole) — parameterized Firebase Auth middleware
 *
 * Execution order:
 *   1. Extract Bearer token from Authorization header.
 *   2. Verify token using firebase-admin/auth.
 *   3. Look up the user by uid in the Firestore `users` collection.
 *   4. Confirm user.role meets the minimum required level.
 *   5. Attach req.hammerUser = { id, uid, email, role, workspaceId, displayName }
 *
 * Errors:
 *   401 — Missing or invalid token
 *   403 — User not in Firestore, or role below minimum
 */

'use strict';

const { getAuth } = require('firebase-admin/auth');
const { db } = require('../lib/firestore');

const ROLE_HIERARCHY = { admin: 4, analyst: 3, instructional_designer: 2, user: 1 };

function requireAuth(minRole) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // Local dev fallback
      if (process.env.NODE_ENV !== 'production' && req.headers['x-dev-user-email']) {
        try {
          const snap = await db.collection('users')
            .where('email', '==', req.headers['x-dev-user-email'].toLowerCase())
            .limit(1).get();
          if (!snap.empty) {
            const doc = snap.docs[0];
            const d = doc.data();
            const userLevel = ROLE_HIERARCHY[d.role] ?? 0;
            const minLevel = ROLE_HIERARCHY[minRole] ?? 99;
            if (userLevel < minLevel) {
              return res.status(403).json({ error: 'forbidden: insufficient role', required: minRole, actual: d.role });
            }
            req.hammerUser = { id: doc.id, uid: doc.id, email: d.email, role: d.role, workspaceId: d.workspaceId, displayName: d.displayName };
            return next();
          }
        } catch (e) {
          return next(e);
        }
      }
      return res.status(401).json({ error: 'unauthenticated: missing Bearer token' });
    }

    const token = authHeader.split('Bearer ')[1];
    try {
      const decodedToken = await getAuth().verifyIdToken(token);
      const { uid, email } = decodedToken;

      // Look up user by UID (assumes doc ID is UID, or query by uid field)
      // Since new signups will use UID as the document ID:
      let userDoc = await db.collection('users').doc(uid).get();
      
      // Fallback: check by email if the document isn't keyed by UID yet
      if (!userDoc.exists && email) {
        const snap = await db.collection('users').where('email', '==', email.toLowerCase()).limit(1).get();
        if (!snap.empty) {
          userDoc = snap.docs[0];
          // Optionally migrate the doc to UID or store UID here, but for now just use it.
        }
      }

      if (!userDoc || !userDoc.exists) {
        return res.status(403).json({ error: 'not provisioned', uid, email });
      }

      const d = userDoc.data();
      const userLevel = ROLE_HIERARCHY[d.role] ?? 0;
      const minLevel = ROLE_HIERARCHY[minRole] ?? 99;

      if (userLevel < minLevel) {
        return res.status(403).json({
          error: 'forbidden: insufficient role',
          required: minRole,
          actual: d.role,
        });
      }

      req.hammerUser = {
        id: userDoc.id,
        uid: uid,
        email: email || d.email,
        role: d.role,
        workspaceId: d.workspaceId,
        displayName: d.displayName ?? null,
      };

      next();
    } catch (err) {
      console.error('[Auth] Token verification failed:', err.message);
      return res.status(401).json({ error: 'unauthenticated: invalid token' });
    }
  };
}

const requireAdmin = requireAuth('admin');
const requireAnalyst = requireAuth('analyst');

module.exports = { requireAuth, requireAdmin, requireAnalyst };
