'use strict';

const crypto = require('crypto');
const { db } = require('../lib/firestore');

function sha256hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Middleware to enforce the 'analyst' (or 'admin') role for programmatic API access.
 * Resolves the X-Api-Key to a user, and checks their role.
 */
async function requireAnalyst(req, res, next) {
  try {
    const raw = req.headers['x-api-key'];
    if (!raw || typeof raw !== 'string') {
      return res.status(401).json({ error: 'Missing or invalid API key' });
    }

    const keyHash = sha256hex(raw);
    const keySnap = await db.collection('api_keys')
      .where('keyHash', '==', keyHash)
      .where('isActive', '==', true)
      .limit(1)
      .get();

    if (keySnap.empty) {
      return res.status(401).json({ error: 'Missing or invalid API key' });
    }

    const keyDoc = keySnap.docs[0].data();
    const userSnap = await db.collection('users').doc(keyDoc.userId).get();
    
    if (!userSnap.exists) {
      return res.status(401).json({ error: 'User not found' });
    }

    const userData = userSnap.data();
    if (userData.role !== 'analyst' && userData.role !== 'admin') {
      return res.status(403).json({ error: 'Requires analyst role' });
    }

    // Attach user context for downstream routes
    req.hammerUser = {
      id: userSnap.id,
      ...userData
    };

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAnalyst };
