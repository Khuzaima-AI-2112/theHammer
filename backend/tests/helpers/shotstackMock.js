'use strict';

/**
 * Shotstack `/render` HTTP double.
 *
 * theHammer calls Shotstack via the platform's global `fetch`
 * (lib/shotstack.js), not an SDK — there is no module for `jest.mock` to
 * replace the way `helpers/gcsMock.js`/`helpers/genaiMock.js` replace
 * `@google-cloud/storage`/`@google/genai`. This factory instead builds a
 * `fetch` replacement: install it with `global.fetch = createShotstackMock(...)`
 * in `beforeEach`, and restore the original `fetch` in `afterEach`.
 *
 * One mock instance answers all three calls lib/shotstack.js makes:
 *   POST {base}/render        → { response: { id } }
 *   GET  {base}/render/{id}   → { response: { id, status, url, error } }
 *   GET  <the render's own url> → the "video" bytes (refreshVideoReportStatus
 *                                  re-hosts the finished render in GCS)
 *
 * Call this directly (not from inside a `jest.mock` factory) — pass options
 * as literals or closures, either way; there is no hoisting restriction here.
 */
function createShotstackMock(options = {}) {
  const renderId = options.renderId || 'mock-render-id';
  const status = options.status || 'done'; // Shotstack's own vocabulary
  const videoUrl = options.videoUrl || 'https://shotstack-cdn.example/mock-video.mp4';
  const errorMessage = options.errorMessage || 'mock render failure';
  const videoBytes = options.videoBytes || Buffer.from('FAKE-MP4-BYTES');

  return jest.fn().mockImplementation((url) => {
    const href = String(url);

    if (href.endsWith('/render')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, response: { id: renderId } }),
      });
    }

    if (href.includes('/render/')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          response: {
            id: renderId,
            status,
            url: status === 'done' ? videoUrl : null,
            error: status === 'failed' ? errorMessage : null,
          },
        }),
      });
    }

    if (href === videoUrl) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(
          videoBytes.buffer.slice(videoBytes.byteOffset, videoBytes.byteOffset + videoBytes.byteLength)
        ),
      });
    }

    return Promise.reject(new Error(`shotstackMock: unexpected fetch to ${href}`));
  });
}

module.exports = { createShotstackMock };
