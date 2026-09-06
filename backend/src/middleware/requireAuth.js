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

const logger = require('../lib/logger');


const { getAuth } = require('firebase-admin/auth');
const { Timestamp } = require('firebase-admin/firestore');
const { db } = require('../lib/firestore');
const { ROLE_HIERARCHY } = require('../lib/roles');
const { USER_PREFERENCES } = require('../lib/defaults');
const collections = require('../lib/collections');

// #81 — lastActiveAt was written once at account creation (users.js,
// workspaces.js) and never again, so the Users table's "Last active" column
// showed the join date forever and the Dashboard's "Active Users Today" tile
// counted accounts *created* today rather than anyone who had actually used
// the product. Stamped here, on every authenticated request, throttled so a
// Firestore write doesn't land on every single API call — option 3 of #81,
// not option 1.
const ACTIVITY_STAMP_THROTTLE_MS = 15 * 60 * 1000;

function nowISO() { return new Date().toISOString(); }

/** True once `lastActiveAt` is missing or older than the throttle window. */
function isActivityStampStale(lastActiveAt) {
  if (!lastActiveAt) return true;
  const lastMs = lastActiveAt instanceof Timestamp
    ? lastActiveAt.toMillis()
    : Date.parse(lastActiveAt);
  return Number.isNaN(lastMs) || (Date.now() - lastMs) >= ACTIVITY_STAMP_THROTTLE_MS;
}

/**
 * Fire-and-forget: refresh lastActiveAt if it's stale, without making the
 * request wait on the write or fail because of it. A user who is active
 * enough to be here again in fifteen minutes is not left looking inactive by
 * a dropped write.
 */
function stampLastActive(userDoc) {
  if (!isActivityStampStale(userDoc.data().lastActiveAt)) return;
  userDoc.ref.update({ lastActiveAt: nowISO() }).catch((err) => {
    logger.error('[Auth] failed to stamp lastActiveAt:', err);
  });
}

function requireAuth(minRole) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // Local dev fallback
      if (process.env.NODE_ENV !== 'production' && req.headers['x-dev-user-email']) {
        try {
          const snap = await db.collection(collections.USERS)
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
            req.hammerUser = {
              id: doc.id,
              uid: doc.id,
              email: d.email,
              role: d.role,
              workspaceId: d.workspaceId,
              displayName: d.displayName,
              inactivityPromptEnabled: d.inactivityPromptEnabled ?? USER_PREFERENCES.inactivityPromptEnabled,
              inactivityTimerSeconds: d.inactivityTimerSeconds ?? USER_PREFERENCES.inactivityTimerSeconds,
              allowPreUploadBlur: d.allowPreUploadBlur ?? USER_PREFERENCES.allowPreUploadBlur,
              instantClipboardLinks: d.instantClipboardLinks ?? USER_PREFERENCES.instantClipboardLinks,
            };
            stampLastActive(doc);
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
      let userDoc = await db.collection(collections.USERS).doc(uid).get();
      
      // Fallback: check by email if the document isn't keyed by UID yet
      if (!userDoc.exists && email) {
        const snap = await db.collection(collections.USERS).where('email', '==', email.toLowerCase()).limit(1).get();
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
        inactivityPromptEnabled: d.inactivityPromptEnabled ?? USER_PREFERENCES.inactivityPromptEnabled,
        inactivityTimerSeconds: d.inactivityTimerSeconds ?? USER_PREFERENCES.inactivityTimerSeconds,
        allowPreUploadBlur: d.allowPreUploadBlur ?? USER_PREFERENCES.allowPreUploadBlur,
        instantClipboardLinks: d.instantClipboardLinks ?? USER_PREFERENCES.instantClipboardLinks,
      };

      stampLastActive(userDoc);
      next();
    } catch (err) {
      // Named fields rather than the whole Error: an expired or malformed token
      // is a routine client condition on the hottest path in the service, and
      // `code` (auth/id-token-expired and friends) is the diagnostic. The stack
      // is the same few frames inside firebase-admin every time, so it would be
      // volume without information.
      logger.error('[Auth] Token verification failed:', { error: err.message, code: err.code });
      return res.status(401).json({ error: 'unauthenticated: invalid token' });
    }
  };
}

/**
 * Verify a Firebase ID token without requiring a Firestore user record.
 *
 * requireAuth refuses a caller who has no `users` document, which is right for
 * every route that acts on an account that already exists. It is wrong for the
 * two routes whose entire job is to create that document. Both carry comments
 * saying they are for users who have just signed up, and both were unreachable
 * by exactly that user, so the `users` collection could never gain its first
 * record and invitations could never be accepted (#33).
 *
 * This middleware stops at identity: the token is genuine, and this is who
 * presented it. Authorisation is left to the route, because the two have
 * different answers — an unclaimed invitation for /workspaces/join, and the
 * configured bootstrap address for /workspaces.
 *
 * It sets `req.firebaseUser`, deliberately not `req.hammerUser`. There is no
 * Hammer user yet, and a half-populated one would be read downstream as a
 * provisioned account with no role.
 *
 * There is no `x-dev-user-email` fallback here on purpose. requireAuth's exists
 * so the suite can authenticate without minting tokens, and it still resolves a
 * real Firestore record. A fallback on this path would skip the record too, and
 * a header that turns any request into a valid identity is not something to add
 * to the one code path that no longer checks provisioning. Tests mock the token
 * verifier instead, as tests/auth.firebase-token.test.js already does.
 */
async function requireFirebaseUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthenticated: missing Bearer token' });
  }

  try {
    const { uid, email } = await getAuth().verifyIdToken(authHeader.split('Bearer ')[1]);

    // Both callers key a user record by email — the invitation is matched on it
    // and the bootstrap address is compared against it. A token without one
    // cannot be turned into a user, so refuse rather than write a broken record.
    if (!email) {
      return res.status(403).json({ error: 'forbidden: token carries no email address' });
    }

    req.firebaseUser = { uid, email: email.toLowerCase() };
    return next();
  } catch (err) {
    // Named fields rather than the whole Error, for the reason given above.
    logger.error('[Auth] Token verification failed:', { error: err.message, code: err.code });
    return res.status(401).json({ error: 'unauthenticated: invalid token' });
  }
}

const requireAdmin = requireAuth('admin');
const requireAnalyst = requireAuth('analyst');

module.exports = { requireAuth, requireAdmin, requireAnalyst, requireFirebaseUser };
