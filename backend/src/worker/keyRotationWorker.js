'use strict';

const logger = require('../lib/logger');


const crypto = require('crypto');
const { db } = require('../../lib/firestore');

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function generateApiKey() {
  return 'hmr_' + crypto.randomBytes(24).toString('base64url');
}

/**
 * Automates API Key rotation for all active users.
 * - Generates a new key per active user
 * - Writes the hash to `api_keys`
 * - Saves the plain key temporarily in `pending_rotations` for email distribution
 * - Sets a 7-day grace period before old keys expire.
 */
async function rotateApiKeys() {
  logger.info('[KeyRotation] Starting API Key rotation process');
  const now = new Date();
  const gracePeriodEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  
  const usersSnap = await db.collection('users').where('isActive', '==', true).get();
  logger.info(`[KeyRotation] Found ${usersSnap.size} active users for rotation.`);

  for (const doc of usersSnap.docs) {
    const user = doc.data();
    const userId = doc.id;
    const plainKey = generateApiKey();
    const keyHash = sha256(plainKey);
    const keyId = `key_${crypto.randomBytes(8).toString('hex')}`;

    await db.runTransaction(async (tx) => {
      // Create new key
      const newKeyRef = db.collection('api_keys').doc(keyId);
      tx.set(newKeyRef, {
        keyHash,
        userId,
        role: user.role,
        createdAt: now.toISOString(),
        isActive: true,
        lastUsed: null,
      });

      // Mark old active keys for expiration
      const oldKeysSnap = await tx.get(db.collection('api_keys').where('userId', '==', userId).where('isActive', '==', true));
      oldKeysSnap.forEach(oldKeyDoc => {
        if (oldKeyDoc.id !== keyId) {
          tx.update(oldKeyDoc.ref, { expiresAt: gracePeriodEnd });
        }
      });

      // Store in pending_rotations (this is where the email worker will pick it up)
      const rotationRef = db.collection('pending_rotations').doc();
      tx.set(rotationRef, {
        userId,
        email: user.email,
        plainKey, // Temporary plain key storage for emailing
        createdAt: now.toISOString(),
        status: 'pending'
      });
    });
    logger.info(`[KeyRotation] Rotated key for user ${userId}`);
  }
}

/**
 * Daily cleanup job to deactivate keys that have passed their grace period.
 */
async function cleanupExpiredKeys() {
  logger.info('[KeyRotation] Starting expired keys cleanup');
  const now = new Date().toISOString();
  
  const expiredSnap = await db.collection('api_keys')
    .where('isActive', '==', true)
    .where('expiresAt', '<=', now)
    .get();

  let count = 0;
  for (const doc of expiredSnap.docs) {
    await doc.ref.update({ isActive: false });
    count++;
  }
  logger.info(`[KeyRotation] Deactivated ${count} expired keys.`);
}

module.exports = { rotateApiKeys, cleanupExpiredKeys };
