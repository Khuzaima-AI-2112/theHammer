/**
 * Bounded look-ahead prefetch (#122)
 *
 * `buildStoryboardPdf` downloaded each Capture's image one at a time inside
 * the page loop — 66 sequential round trips to Cloud Storage for the real
 * Softomedia draft, 89.7s of them from a developer machine. This is the seam
 * that makes those round trips overlap.
 *
 * Two properties matter, and they pull against each other:
 *
 *  - **In order.** A Storyboard is an *ordered* set of Captures; the order is
 *    the thing the artifact is for. Fetching concurrently must not let the
 *    faster download draw first.
 *  - **Bounded.** Not just the calls in flight: the images already fetched and
 *    not yet drawn are held in memory too, and the backend deploys with
 *    `--memory 512Mi` alongside an accumulating uncompressed PDF buffer. A
 *    pool that starts a new fetch the moment one lands would finish holding
 *    all 66 images at once; this holds at most `ahead` of them.
 *
 * Pure: no Firestore, no Cloud Storage, no pdfkit. The fetches here are
 * deferred promises the test resolves by hand, which is what makes "in flight
 * at once" something a test can count rather than time.
 */
'use strict';

const { prefetchInOrder } = require('../src/lib/prefetch');

/** A promise this test settles by hand, so "still in flight" is a fact. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Lets every already-resolved microtask run before we assert on it. */
const settle = () => new Promise((resolve) => { setImmediate(resolve); });

/**
 * A fetcher over `count` deferred promises that counts what is outstanding.
 *
 * `started` is the order fetches were issued in, `maxInFlight` the high-water
 * mark of issued-but-unsettled — the number `ahead` is supposed to cap.
 */
function gatedFetcher(count) {
  const gates = Array.from({ length: count }, () => deferred());
  const state = { started: [], inFlight: 0, maxInFlight: 0 };

  const fetchOne = (item) => {
    state.started.push(item);
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const done = () => { state.inFlight -= 1; };
    gates[item].promise.then(done, done);
    return gates[item].promise;
  };

  return { gates, state, fetchOne };
}

const items = (n) => Array.from({ length: n }, (_, i) => i);

describe('prefetchInOrder', () => {
  test('yields in the given order however the fetches settle', async () => {
    const order = [];
    const fetchOne = async (item) => {
      // Later items land first: the last one resolves immediately, the first
      // only after every other has had a turn.
      await new Promise((resolve) => { setTimeout(resolve, (5 - item) * 4); });
      return `image-${item}`;
    };

    for await (const { item, value } of prefetchInOrder(items(6), fetchOne, { ahead: 6 })) {
      order.push([item, value]);
    }

    expect(order).toEqual([
      [0, 'image-0'], [1, 'image-1'], [2, 'image-2'],
      [3, 'image-3'], [4, 'image-4'], [5, 'image-5'],
    ]);
  });

  test('never leaves more than `ahead` fetches outstanding', async () => {
    const { gates, state, fetchOne } = gatedFetcher(10);
    const consumed = [];

    const consumer = (async () => {
      for await (const { value } of prefetchInOrder(items(10), fetchOne, { ahead: 3 })) {
        consumed.push(value);
      }
    })();

    // Resolve one at a time, checking the pool after each: a fetch only
    // starts because an earlier one was consumed, never because the loop
    // felt like running ahead.
    for (let i = 0; i < 10; i += 1) {
      gates[i].resolve(`image-${i}`);
      await settle();
      expect(state.inFlight).toBeLessThanOrEqual(3);
    }

    await consumer;
    expect(state.maxInFlight).toBe(3);
    expect(consumed).toEqual(items(10).map((i) => `image-${i}`));
  });

  test('fetches ahead of the consumer rather than one at a time', async () => {
    // The regression this whole ticket is about: a sequential loop also
    // "never exceeds `ahead`", by never exceeding one.
    const { state, fetchOne } = gatedFetcher(10);

    const iterator = prefetchInOrder(items(10), fetchOne, { ahead: 4 })[Symbol.asyncIterator]();
    iterator.next();
    await settle();

    expect(state.started).toEqual([0, 1, 2, 3]);
  });

  test('a fetch that fails throws at that item, after the ones before it', async () => {
    const seen = [];
    const fetchOne = async (item) => {
      if (item === 2) throw new Error('storage unavailable');
      return `image-${item}`;
    };

    const walk = (async () => {
      for await (const { item } of prefetchInOrder(items(5), fetchOne, { ahead: 5 })) {
        seen.push(item);
      }
    })();

    await expect(walk).rejects.toThrow('storage unavailable');
    // 0 and 1 were drawn before the failure surfaced, and 3 and 4 — already
    // fetched by then — never were.
    expect(seen).toEqual([0, 1]);
  });

  test('abandoning the walk leaves no unhandled rejection behind', async () => {
    // Every fetch after the one that failed is still outstanding when the
    // consumer stops. Node treats a rejected promise nobody awaited as an
    // unhandled rejection and, under `--unhandled-rejections=throw`, kills
    // the process — a finalize that failed on Capture 3 would take the
    // whole Cloud Run instance down with it rather than answering 500.
    const unhandled = [];
    const record = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', record);

    try {
      const fetchOne = async (item) => {
        if (item > 0) throw new Error(`capture ${item} is unreadable`);
        return 'image-0';
      };

      // eslint-disable-next-line no-unused-vars
      for await (const _ of prefetchInOrder(items(6), fetchOne, { ahead: 6 })) {
        break; // takes item 0 and walks away while 1–5 are in flight
      }

      await settle();
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  test('a fetcher that throws synchronously rejects like any other failure', async () => {
    const fetchOne = () => { throw new Error('bad path'); };

    const walk = (async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of prefetchInOrder(items(3), fetchOne, { ahead: 2 })) { /* unreachable */ }
    })();

    await expect(walk).rejects.toThrow('bad path');
  });

  test('refuses to walk without a bound, rather than choosing one', async () => {
    // There is no default `ahead`: the bound is a claim about the caller's
    // memory, and a default here would be a second copy of a number that
    // belongs beside the work it bounds.
    const walk = (async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of prefetchInOrder(items(3), async () => 'x')) { /* unreachable */ }
    })();

    await expect(walk).rejects.toThrow(RangeError);
  });

  test('an empty list fetches nothing', async () => {
    const { state, fetchOne } = gatedFetcher(0);
    const seen = [];

    for await (const entry of prefetchInOrder([], fetchOne, { ahead: 8 })) {
      seen.push(entry);
    }

    expect(seen).toEqual([]);
    expect(state.started).toEqual([]);
  });
});
