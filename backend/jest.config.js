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
  testTimeout: 30000,
  setupFiles: ['<rootDir>/tests/setup/env.js'],
  // Drains fire-and-forget writes before each suite's environment is
  // destroyed. setupFilesAfterEnv rather than setupFiles because it registers
  // an afterAll, which needs the test framework to exist. See
  // src/lib/pendingWrites.js.
  setupFilesAfterEnv: ['<rootDir>/tests/setup/drain-pending-writes.js']
};
