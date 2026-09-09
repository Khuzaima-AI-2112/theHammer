'use strict';

/**
 * Which Captures an OCR Report compares (#96, ADR 0017).
 *
 * The unit is a **Storyboard**: an ordered set of Captures, with a note against
 * each, that an Analyst curated to demonstrate one workflow. The Report walks
 * that order in consecutive pairs and asks what changed at each step.
 *
 * The rejected alternative is the one the pipeline's shape invites — pairing a
 * Project's Captures by time. Softomedia's 66 Captures span 28 distinct
 * `tabUrl`s and 8 `tool` values, so that means repeatedly asking a model what
 * changed between two screenshots of unrelated pages. It would answer, and the
 * answer would be #96's own defect returning one layer down.
 *
 * Three rules make the selection honest rather than merely cheap:
 *
 *  - **Consecutive only.** Never sampled, never bridged.
 *  - **An Abandoned Upload breaks the chain.** A Capture whose bytes never
 *    landed is skipped and no pair spans it — bridging would report as one
 *    change what may have taken several steps. (It would also fail the Vertex
 *    request outright: one unreadable `gs://` URI rejects the whole call.)
 *  - **Capped, and the coverage is stated.** See OCR_MAX_PAIRS in models.js.
 */

const { Storage } = require('@google-cloud/storage');
const { db } = require('./firestore');
const collections = require('./collections');
const { OCR_MAX_PAIRS } = require('./models');

const BUCKET = process.env.GCS_BUCKET || 'thehammer-storage-2026';

/** Lazily constructed: module scope is what #19 is open about. */
let storage = null;
function getStorage() {
  if (!storage) storage = new Storage();
  return storage;
}

/**
 * Fewer than two included Captures: there is no pair to compare.
 *
 * A named error rather than an empty result, because the two cases must not be
 * confused. "You did not give me two steps" is a fact about the Storyboard the
 * Analyst can act on; "both images are missing" is a fact about the Project.
 * An empty Report that means either is the ambiguity this issue's family is
 * made of.
 */
class TooFewCapturesError extends Error {
  constructor(includedCount) {
    super(
      `A comparison needs at least two included Captures; this Storyboard has ${includedCount}.`
    );
    this.name = 'TooFewCapturesError';
    this.includedCount = includedCount;
  }
}

/**
 * The Captures in the Analyst's order, each with the object path behind it.
 *
 * `gcsPath ?? path` matches what buildNarrativeRequest already reads: the
 * Capture write path stores `path`, and some rows carry `gcsPath` instead.
 */
async function resolveIncluded(draft) {
  const included = [...(draft.captures ?? [])]
    .filter((c) => c.included)
    .sort((a, b) => a.order - b.order);

  if (included.length < 2) throw new TooFewCapturesError(included.length);

  const refs = included.map((c) => db.collection(collections.UPLOADS).doc(c.captureId));
  const snaps = await db.getAll(...refs);
  const uploadById = {};
  snaps.forEach((s) => { if (s.exists) uploadById[s.id] = s.data(); });

  return included.map((c) => {
    const upload = uploadById[c.captureId];
    const objectPath = upload?.gcsPath ?? upload?.path ?? null;
    return {
      captureId: c.captureId,
      order: c.order,
      note: c.note ?? '',
      objectPath,
    };
  });
}

/**
 * Which of these Captures actually have an image.
 *
 * One metadata read each, in parallel — negligible beside the model calls that
 * follow, and the alternative is discovering it as a failed Vertex request
 * after paying for the ones before it.
 */
async function markPresent(captures) {
  const bucket = getStorage().bucket(BUCKET);
  return Promise.all(captures.map(async (c) => {
    if (!c.objectPath) return { ...c, present: false };
    const [present] = await bucket.file(c.objectPath).exists();
    return { ...c, present };
  }));
}

/** What the model is shown, and what the artifact records about each side. */
function side(capture) {
  return {
    captureId: capture.captureId,
    order: capture.order,
    note: capture.note,
    gcsUri: `gs://${BUCKET}/${capture.objectPath}`,
  };
}

/**
 * The comparisons to make, and what they cover.
 *
 * `coverage` is returned rather than derived by the caller because every number
 * in it is a statement the Report has to make out loud: how much of the
 * workflow was examined, how much was not, and why.
 *
 * @throws {TooFewCapturesError} when the Storyboard has fewer than two
 *   included Captures.
 */
async function selectComparablePairs(draft, { maxPairs = OCR_MAX_PAIRS } = {}) {
  const captures = await markPresent(await resolveIncluded(draft));

  const available = [];
  for (let i = 0; i < captures.length - 1; i += 1) {
    const from = captures[i];
    const to = captures[i + 1];
    // The chain breaks at a missing image rather than reaching past it.
    if (from.present && to.present) available.push({ from: side(from), to: side(to) });
  }

  const comparisons = available.slice(0, maxPairs);

  return {
    comparisons,
    coverage: {
      includedCaptures: captures.length,
      droppedCaptures: captures.filter((c) => !c.present).length,
      availablePairs: available.length,
      comparedPairs: comparisons.length,
      maxPairs,
      capped: available.length > comparisons.length,
    },
  };
}

module.exports = { BUCKET, TooFewCapturesError, selectComparablePairs };
