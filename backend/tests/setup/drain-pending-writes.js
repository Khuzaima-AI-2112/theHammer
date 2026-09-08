'use strict';

/**
 * Waits for fire-and-forget writes to finish before Jest tears a suite down.
 *
 * Runs in every suite (jest.config.js `setupFilesAfterEnv`), because the suite
 * that leaks a write is not the suite that fails. See src/lib/pendingWrites.js
 * for what goes wrong without this and which build it broke.
 *
 * Requires only that module — no app, no Firestore client — so a suite that
 * mocks parts of the backend before requiring it is unaffected.
 */

const { drain } = require('../../src/lib/pendingWrites');

afterAll(async () => {
  await drain();
});
