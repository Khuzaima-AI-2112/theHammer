/**
 * Firestore singleton  —  shared across all route handlers.
 *
 * In Cloud Run: uses Application Default Credentials automatically.
 * In local dev:  set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON,
 *                or use `gcloud auth application-default login`.
 *
 * DATABASE_ID defaults to '(default)'.  Override via env var if you add
 * additional Firestore databases in the future.
 */

'use strict';

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore }           = require('firebase-admin/firestore');

if (getApps().length === 0) {
  initializeApp();   // uses ADC / FIREBASE_CONFIG env var in Cloud Run
}

const db = getFirestore(process.env.DATABASE_ID ?? '(default)');

// Firestore emulator support for local dev / CI
if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.info(`[firestore] using emulator at ${process.env.FIRESTORE_EMULATOR_HOST}`);
}

module.exports = { db };
