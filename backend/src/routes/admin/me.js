/**
 * Sprint 5.13  —  GET /me
 *
 * Identity endpoint for the Admin Portal SPA auth gate.
 * Returns the Firestore user record for the IAP-authenticated caller.
 *
 * Mounted at app.use('/', router) so the path is GET /me (not /admin/me).
 * The SPA calls GET /me once on boot to populate the topbar user chip
 * and determine whether to show the admin UI.
 *
 * Response shape:
 *   200 { id, email, displayName, role, provisioned: true,  lastActiveAt }
 *   403 { error: 'not provisioned', email }   — authenticated but not in Firestore
 *   401 { error: 'unauthenticated' }           — IAP header absent
 *
 * This route does NOT require a role — any provisioned IAP identity may call it.
 * Role gating happens inside the admin routes.
 */

'use strict';

const express = require('express');
const { Timestamp } = require('firebase-admin/firestore');
const { db } = require('../../lib/firestore');
const { extractIAPEmail } = require('../../middleware/requireAdmin');

const router = express.Router();

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

module.exports = router;
