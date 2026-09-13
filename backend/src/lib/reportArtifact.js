'use strict';

/**
 * Reading a Report's artifact back out of Cloud Storage (#120).
 *
 * Every Report lands in a bucket and, until this existed, stopped there: the
 * portal's viewer wrote a `[Mockup]` string into the panel, so real metrics
 * (#8), a working narrative (#107/#108) and an honest one (#119) were all
 * invisible inside the product. Lesson 66 — a comment admitting the code is
 * mocked is an unfiled defect report.
 *
 * The awkward part is that `gcsPath` is stored in two shapes by four writers,
 * and nothing ever reconciled them:
 *
 *   reportsWorker.js / ocrWorker.js   `gs://bucket/projectId/reports/id.json`
 *   storyboards.js:786 (PDF)         `projectId/reports/id.pdf`
 *   lib/shotstack.js:121 (video)     `projectId/reports/id.mp4`
 *
 * A reader that handled one shape would work for exactly half the Reports in
 * the product, and would fail on the half a Customer is most likely to open.
 * Both are parsed here, in one place, rather than at the call site.
 */

const { getStorage } = require('./storage');

const BUCKET = process.env.GCS_BUCKET || 'thehammer-storage-2026';

/**
 * How long a signed URL for a binary artifact is good for.
 *
 * Long enough to click and for a PDF or video to finish loading, short enough
 * that a URL copied out of the network tab stops working before it can be
 * passed around. The tenancy check happens when the URL is minted, not when it
 * is used, so the lifetime is the only thing limiting a leaked one.
 */
const SIGNED_URL_TTL_MS = 5 * 60 * 1000;

/**
 * Content types by extension, for the artifacts this product actually writes.
 *
 * Deliberately a closed list rather than a lookup library: an unknown
 * extension is served as a download rather than guessed at, because guessing
 * wrong here means handing a browser something to render that it should not.
 */
const CONTENT_TYPES = Object.freeze({
  json: 'application/json',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  wav: 'audio/wav',
});

/**
 * `{ bucket, object }` for a stored `gcsPath`, or `null` if there is nothing
 * stored. Absolute `gs://` URIs carry their own bucket; a bare object path
 * belongs to the configured one.
 */
function parseGcsPath(gcsPath, fallbackBucket = BUCKET) {
  if (typeof gcsPath !== 'string' || gcsPath === '') return null;
  const absolute = /^gs:\/\/([^/]+)\/(.+)$/.exec(gcsPath);
  if (absolute) return { bucket: absolute[1], object: absolute[2] };
  return { bucket: fallbackBucket, object: gcsPath };
}

/** The content type an artifact's object path implies. */
function contentTypeFor(objectPath) {
  const ext = String(objectPath).split('.').pop().toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

/**
 * What the viewer should be handed for one artifact.
 *
 * JSON comes back parsed, because it is small and the alternative is a signed
 * URL that reads the artifact outside the tenancy check that just ran. Binary
 * comes back as a short-lived signed URL, because the alternative is streaming
 * a video through the API.
 *
 * `null` when the object is not there. The row is the claim and the object is
 * the evidence; Storage Lifetime can remove the second while the first stays.
 */
async function readReportArtifact(gcsPath) {
  const location = parseGcsPath(gcsPath);
  if (!location) return null;

  const file = getStorage().bucket(location.bucket).file(location.object);
  const [exists] = await file.exists();
  if (!exists) return null;

  const contentType = contentTypeFor(location.object);

  if (contentType === CONTENT_TYPES.json) {
    const [body] = await file.download();
    return { contentType, artifact: JSON.parse(body.toString('utf8')) };
  }

  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + SIGNED_URL_TTL_MS,
  });
  return { contentType, url };
}

module.exports = {
  BUCKET,
  CONTENT_TYPES,
  SIGNED_URL_TTL_MS,
  parseGcsPath,
  contentTypeFor,
  readReportArtifact,
};
