'use strict';

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
    this.save = jest.fn().mockResolvedValue();
    this.getSignedUrl = jest.fn().mockImplementation(
      () => Promise.resolve([`${signedUrlPrefix}${name}?X-Goog-Signature=abc`])
    );
    // download() answers the real client's shape: a one-element array holding
    // the object's bytes. The bytes embed the object path so an export test can
    // prove a given Capture's bytes landed under the file name it expected,
    // rather than only that some file of the right size is present.
    this.download = jest.fn().mockImplementation(
      () => Promise.resolve([Buffer.from(`PNGBYTES:${name}`)])
    );
  }

  return {
    Storage: jest.fn().mockImplementation(() => ({
      bucket: () => ({ file: (name) => new MockFile(name) })
    }))
  };
}

module.exports = { createStorageMock };
