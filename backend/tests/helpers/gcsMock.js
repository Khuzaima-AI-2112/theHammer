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
      bucket: () => ({ file: (name) => new MockFile(name) })
    }))
  };
}

module.exports = { createStorageMock };
