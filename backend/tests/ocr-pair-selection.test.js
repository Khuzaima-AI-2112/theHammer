/**
 * #96 — which Captures an OCR Report compares (ADR 0017).
 *
 * The unit is a Storyboard: an ordered set of Captures, curated by an Analyst,
 * demonstrating one workflow. The Report walks that order in consecutive pairs.
 *
 * Three rules here are not details, they are the issue:
 *
 *  - **Consecutive only.** Never sampled, never bridged. A comparison that
 *    spans a skipped Capture reports as one change what may have taken three.
 *  - **Abandoned Uploads break the chain.** A Capture whose bytes never landed
 *    (CONTEXT.md: *Abandoned Upload*) is skipped and no pair spans it. One bad
 *    `gs://` URI would also fail the whole Vertex request.
 *  - **Capped.** The first OCR_MAX_PAIRS pairs, with the coverage that produces
 *    stated rather than left for the reader to infer.
 *
 * Firestore: emulator. Cloud Storage: mocked, with a real object store behind
 * it, so "the row exists but the object does not" is testable rather than
 * assumed.
 */
'use strict';

jest.mock('@google-cloud/storage', () => {
  const objects = new Set();
  function MockFile(bucket, name) {
    this.name = name;
    this.exists = jest.fn(async () => [objects.has(name)]);
  }
  return {
    Storage: jest.fn().mockImplementation(() => ({
      bucket: (bucketName) => ({ file: (name) => new MockFile(bucketName, name) }),
    })),
    __objects: objects,
  };
});

process.env.GCS_BUCKET = 'fake-bucket';

const { __objects } = require('@google-cloud/storage');
const { db } = require('../src/lib/firestore');
const collections = require('../src/lib/collections');
const { clearDatabase } = require('./helpers/fixtures');
const { OCR_MAX_PAIRS } = require('../src/lib/models');
const { selectComparablePairs, TooFewCapturesError } = require('../src/lib/ocrPairs');

const PROJECT = 'pairs-project';

/** A Capture row with an object behind it, unless `abandoned`. */
async function seedCapture(id, { abandoned = false } = {}) {
  const path = `${PROJECT}/${id}.png`;
  await db.collection(collections.UPLOADS).doc(id).set({
    projectId: PROJECT, workspaceId: 'pairs-workspace', userId: 'u1',
    tool: 'Softomedia', stage: '', tabUrl: 'https://example.test/',
    path, bucket: 'fake-bucket', size: 10,
    uploadedAt: new Date('2026-09-01T10:00:00.000Z').toISOString(),
    hasSemanticData: false, schemaVersion: 1,
  });
  if (!abandoned) __objects.add(path);
  return id;
}

/** A draft whose captures are `ids`, all included, in the order given. */
function draftOf(ids, overrides = {}) {
  return {
    projectId: PROJECT,
    captures: ids.map((id, i) => ({
      captureId: id, order: i + 1, included: true, note: `note for ${id}`,
    })),
    ...overrides,
  };
}

async function seedCaptures(n, abandonedIds = []) {
  const ids = [];
  for (let i = 1; i <= n; i += 1) {
    const id = `c${i}`;
    await seedCapture(id, { abandoned: abandonedIds.includes(id) });
    ids.push(id);
  }
  return ids;
}

beforeEach(async () => {
  await clearDatabase();
  __objects.clear();
});

afterAll(async () => {
  await clearDatabase();
});

describe('consecutive pairs, in the Analyst\'s order', () => {
  test('four Captures make three pairs, each with its predecessor', async () => {
    const ids = await seedCaptures(4);

    const { comparisons } = await selectComparablePairs(draftOf(ids));

    expect(comparisons.map((c) => [c.from.captureId, c.to.captureId]))
      .toEqual([['c1', 'c2'], ['c2', 'c3'], ['c3', 'c4']]);
  });

  test('the Storyboard order wins, not the order the captures were taken', async () => {
    const ids = await seedCaptures(3);
    // The Analyst reordered: c3 first, then c1, then c2.
    const draft = {
      projectId: PROJECT,
      captures: [
        { captureId: 'c3', order: 1, included: true, note: '' },
        { captureId: 'c1', order: 2, included: true, note: '' },
        { captureId: 'c2', order: 3, included: true, note: '' },
      ],
    };

    const { comparisons } = await selectComparablePairs(draft);

    expect(comparisons.map((c) => [c.from.captureId, c.to.captureId]))
      .toEqual([['c3', 'c1'], ['c1', 'c2']]);
    expect(ids).toHaveLength(3);
  });

  test('excluded Captures are not in the workflow and form no pairs', async () => {
    const ids = await seedCaptures(4);
    const draft = draftOf(ids);
    draft.captures[1].included = false;

    const { comparisons, coverage } = await selectComparablePairs(draft);

    // c2 is not part of this workflow at all, so c1 pairs with c3: the Analyst
    // removed the step, unlike an Abandoned Upload where the step happened and
    // the evidence is missing.
    expect(comparisons.map((c) => [c.from.captureId, c.to.captureId]))
      .toEqual([['c1', 'c3'], ['c3', 'c4']]);
    expect(coverage.includedCaptures).toBe(3);
  });

  test('each side carries the Storyboard position and the note', async () => {
    const ids = await seedCaptures(2);

    const { comparisons } = await selectComparablePairs(draftOf(ids));

    expect(comparisons[0].from).toMatchObject({ captureId: 'c1', order: 1, note: 'note for c1' });
    expect(comparisons[0].to).toMatchObject({ captureId: 'c2', order: 2, note: 'note for c2' });
    expect(comparisons[0].from.gcsUri).toBe(`gs://fake-bucket/${PROJECT}/c1.png`);
  });
});

describe('an Abandoned Upload breaks the chain', () => {
  test('no pair spans a Capture whose image never landed', async () => {
    const ids = await seedCaptures(4, ['c2']);

    const { comparisons, coverage } = await selectComparablePairs(draftOf(ids));

    // Emphatically not [c1,c3]: that would report as one change what took two
    // steps. c1 and c3 each lose their pair with c2, and the chain resumes.
    expect(comparisons.map((c) => [c.from.captureId, c.to.captureId]))
      .toEqual([['c3', 'c4']]);
    expect(coverage.droppedCaptures).toBe(1);
  });

  test('two adjacent missing images drop three pairs, not one', async () => {
    const ids = await seedCaptures(5, ['c2', 'c3']);

    const { comparisons } = await selectComparablePairs(draftOf(ids));

    expect(comparisons.map((c) => [c.from.captureId, c.to.captureId]))
      .toEqual([['c4', 'c5']]);
  });

  test('a Capture row with no path at all is treated as abandoned', async () => {
    await seedCaptures(2);
    await db.collection(collections.UPLOADS).doc('c-pathless').set({
      projectId: PROJECT, workspaceId: 'pairs-workspace', userId: 'u1',
      uploadedAt: new Date().toISOString(), schemaVersion: 1,
    });
    const draft = draftOf(['c1', 'c-pathless', 'c2']);

    const { comparisons, coverage } = await selectComparablePairs(draft);

    expect(comparisons).toEqual([]);
    expect(coverage.droppedCaptures).toBe(1);
  });

  test('a captureId with no Capture row at all is dropped, not guessed at', async () => {
    await seedCaptures(2);
    const draft = draftOf(['c1', 'ghost', 'c2']);

    const { comparisons, coverage } = await selectComparablePairs(draft);

    expect(comparisons).toEqual([]);
    expect(coverage.droppedCaptures).toBe(1);
  });
});

describe('the cap', () => {
  test('a long Storyboard is compared up to the cap and no further', async () => {
    const ids = await seedCaptures(OCR_MAX_PAIRS + 6);

    const { comparisons, coverage } = await selectComparablePairs(draftOf(ids));

    expect(comparisons).toHaveLength(OCR_MAX_PAIRS);
    expect(comparisons[0].from.captureId).toBe('c1');
    expect(coverage.comparedPairs).toBe(OCR_MAX_PAIRS);
    expect(coverage.availablePairs).toBe(OCR_MAX_PAIRS + 5);
    expect(coverage.capped).toBe(true);
  });

  test('the cap is the first pairs, never a sample across the whole', async () => {
    // Sampling was rejected in ADR 0017: non-adjacent frames report as one
    // change what may have taken several steps.
    const ids = await seedCaptures(OCR_MAX_PAIRS + 6);

    const { comparisons } = await selectComparablePairs(draftOf(ids));

    const orders = comparisons.map((c) => c.from.order);
    expect(orders).toEqual(orders.map((_, i) => i + 1));
  });

  test('a Storyboard inside the cap is not marked capped', async () => {
    const ids = await seedCaptures(3);

    const { coverage } = await selectComparablePairs(draftOf(ids));

    expect(coverage.capped).toBe(false);
    expect(coverage.comparedPairs).toBe(2);
  });

  test('the caller can ask for a smaller cap than the default', async () => {
    const ids = await seedCaptures(6);

    const { comparisons } = await selectComparablePairs(draftOf(ids), { maxPairs: 2 });

    expect(comparisons).toHaveLength(2);
  });
});

describe('too little to compare', () => {
  test('a Storyboard with one included Capture refuses rather than reporting nothing', async () => {
    const ids = await seedCaptures(3);
    const draft = draftOf(ids);
    draft.captures[1].included = false;
    draft.captures[2].included = false;

    await expect(selectComparablePairs(draft)).rejects.toThrow(TooFewCapturesError);
  });

  test('a Storyboard with no included Captures refuses too', async () => {
    const ids = await seedCaptures(2);
    const draft = draftOf(ids);
    draft.captures.forEach((c) => { c.included = false; });

    await expect(selectComparablePairs(draft)).rejects.toThrow(TooFewCapturesError);
  });

  test('two included Captures whose images are both gone is not a refusal', async () => {
    // The Storyboard was comparable; the evidence is missing. That is a
    // different fact about the Project, and the artifact must say which.
    const ids = await seedCaptures(2, ['c1', 'c2']);

    const { comparisons, coverage } = await selectComparablePairs(draftOf(ids));

    expect(comparisons).toEqual([]);
    expect(coverage.droppedCaptures).toBe(2);
    expect(coverage.includedCaptures).toBe(2);
  });
});
