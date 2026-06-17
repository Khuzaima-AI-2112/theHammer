/**
 * Sprint 5.13  —  GET /admin/me
 *
 * Used by the SPA auth gate on startup.
 * Returns the Firestore user record for the IAP-authenticated caller.
 *
 * Response shape:
 *   200 { id, email, displayName, role, provisioned: true }
 *   401 { error: 'unauthenticated' }           — IAP header missing (dev: expected)
 *   403 { error: 'not provisioned', email }    — authenticated but not in Firestore
 *
 * This route does NOT use requireAdmin — it's callable by any authenticated user.
 * It uses requireIAP (header extraction only) so the SPA can detect role.
 */

'use strict';

const express = require('express');
const { Timestamp } = require('firebase-admin/firestore');
const { db } = require('../../lib/firestore');
const { extractIAPEmail } = require('../../middleware/requireAdmin');

const router = express.Router();

router.get('/me', async (req, res) => {
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

  const d = snap.docs[0].data();
  return res.json({
    id:           snap.docs[0].id,
    email:        d.email,
    displayName:  d.displayName ?? null,
    role:         d.role,
    provisioned:  true,
    lastActiveAt: d.lastActiveAt instanceof Timestamp
                    ? d.lastActiveAt.toDate().toISOString()
                    : d.lastActiveAt,
  });
});

module.exports = router;
