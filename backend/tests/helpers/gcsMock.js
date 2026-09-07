'use strict';

// A real, minimally valid 1x1 red PNG — every chunk length and CRC32 is
// correct. Only used when a caller opts into `realPngBytes`: unlike a ZIP
// archive, which stores bytes as-is, embedding an image into a PDF (#89)
// means pdfkit actually parses the PNG signature, so the placeholder
// `PNGBYTES:<name>` string every other caller relies on won't do.
const REAL_PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de' +
  '0000000c49444154789c63f8cfc0000003010100c9fe92ef0000000049454e44ae426082',
  'hex'
);

/**
 * The objects the double is holding, by name.
 *
 * Module-level rather than per-mock because a `jest.mock` factory may not close
 * over out-of-scope variables — the test file and the factory both reach the
 * store through this module, which is the one thing they can share. A test
 * seeds with `seedObject`, reads back with `listObjects`, and clears between
 * cases with `resetObjects`.
 *
 * Added for #114. Before it the double exposed only `bucket().file(name)`, so
 * the storage half of a Purge — the half #109 was actually about — could not be
 * asserted at all: there was no object list for a prefix delete to empty.
 */
const objects = new Map();

/** Put an object in the bucket, as an upload would. */
function seedObject(name, contents = null) {
  objects.set(String(name), contents);
  return String(name);
}

/** Every object name currently in the bucket, sorted. Optionally by prefix. */
function listObjects(prefix = '') {
  return [...objects.keys()].filter((n) => n.startsWith(prefix)).sort();
}

/**
 * Arm the next prefix delete to fail, once.
 *
 * The ordering rule — children first, the Project document last — is only
 * observable if a step in the middle can be made to fail, so #114 asserts it by
 * arming this, Purging, and then checking the Project is still there and that a
 * re-run finishes the job. Without an injectable failure the retry property
 * could only be reasoned about, not tested.
 */
let failNextDelete = null;
function failNextPrefixDelete(message = 'storage unavailable') {
  failNextDelete = message;
}

/** Empty the bucket and disarm any injected failure. Call in `beforeEach`. */
function resetObjects() {
  objects.clear();
  failNextDelete = null;
}

/**
 * Shared Cloud Storage double.
 *
 * Tests must never make real network calls, and more than one suite needs the
 * same `bucket().file()` shape. `getSignedUrl` embeds the object path in the URL
 * it returns, so a test can assert that the path in the URL matches the path in
 * the response body.
 *
 * Call this from inside a `jest.mock` factory. Such a factory may not close over
 * out-of-scope variables, so pass any options in as a literal.
 */
function createStorageMock(options = {}) {
  const signedUrlPrefix = options.signedUrlPrefix || 'https://storage.googleapis.com/fake-bucket/';

  function MockFile(name) {
    this.name = name;
    // A saved object joins the bucket, so a prefix listing afterwards sees what
    // an upload actually wrote rather than only what a test remembered to seed.
    this.save = jest.fn().mockImplementation((contents) => {
      seedObject(name, contents ?? null);
      return Promise.resolve();
    });
    this.getSignedUrl = jest.fn().mockImplementation(
      () => Promise.resolve([`${signedUrlPrefix}${name}?X-Goog-Signature=abc`])
    );
    // download() answers the real client's shape: a one-element array holding
    // the object's bytes. By default the bytes embed the object path so an
    // export test can prove a given Capture's bytes landed under the file
    // name it expected, rather than only that some file of the right size is
    // present. `realPngBytes: true` swaps in an actually-decodable PNG for a
    // caller (e.g. PDF assembly) that parses the image rather than just
    // moving the bytes around.
    this.download = jest.fn().mockImplementation(
      () => Promise.resolve([options.realPngBytes ? REAL_PNG_BYTES : Buffer.from(`PNGBYTES:${name}`)])
    );
  }

  return {
    Storage: jest.fn().mockImplementation(() => ({
      bucket: () => ({
        file: (name) => new MockFile(name),
        // The real client answers `[files]` — a one-element array holding the
        // matches — and both of these accept a bare prefix string.
        getFiles: (opts = {}) => Promise.resolve([
          listObjects(typeof opts === 'string' ? opts : (opts.prefix ?? ''))
            .map((n) => new MockFile(n))
        ]),
        // A prefix that matches nothing is not an error, in the real client and
        // here: an Abandoned Upload is a record whose object never arrived, and
        // Purging one must not fail (#114).
        deleteFiles: (opts = {}) => {
          if (failNextDelete) {
            const message = failNextDelete;
            failNextDelete = null;
            return Promise.reject(new Error(message));
          }
          const prefix = typeof opts === 'string' ? opts : (opts.prefix ?? '');
          for (const name of listObjects(prefix)) objects.delete(name);
          return Promise.resolve();
        }
      })
    }))
  };
}

module.exports = {
  createStorageMock, seedObject, listObjects, resetObjects, failNextPrefixDelete,
};
