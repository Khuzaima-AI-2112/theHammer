'use strict';

/**
 * The one Cloud Storage client, constructed on first use (#19).
 *
 * `new Storage()` starts resolving Application Default Credentials. Doing that
 * at module scope meant requiring the app opened a connection to the GCE
 * metadata server, and on a machine where nothing answers it Jest could not
 * exit. It happened in index.js and in seven modules it loads, so every caller
 * gets the client from here instead, and nothing touches credentials until a
 * request actually needs a bucket.
 *
 * The package is required here, not passed in, so a test's
 * `jest.mock('@google-cloud/storage', ...)` still replaces what this builds.
 * tests/storage-client-lazy.test.js holds both properties.
 */

const { Storage } = require('@google-cloud/storage');

let client = null;

function getStorage() {
  if (!client) client = new Storage();
  return client;
}

module.exports = { getStorage };
