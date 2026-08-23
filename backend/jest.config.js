'use strict';

/**
 * The suite runs against the Firestore emulator, so several hooks clear the
 * database and seed fixtures over the network before any test runs. On a cold
 * emulator that work exceeds Jest's 5s default hook budget, and the resulting
 * timeouts read as product defects rather than as a harness that is too
 * impatient. 30s absorbs a cold start while still failing a genuinely hung test
 * in reasonable time.
 */
module.exports = {
  testEnvironment: 'node',
  testTimeout: 30000,
  setupFiles: ['<rootDir>/tests/setup/env.js']
};
