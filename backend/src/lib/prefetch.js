'use strict';

/**
 * Overlapping slow fetches without losing their order (#122).
 *
 * `buildStoryboardPdf` downloads one Capture image per frame it draws. Done
 * one at a time that is 66 sequential round trips to Cloud Storage for the
 * real Softomedia Storyboard, and what one costs depends entirely on where
 * the code is running: 5.2s for the whole finalize in Cloud Run, which shares
 * a region with the bucket, against 89.7s of assembly alone from a developer
 * machine over the public internet. Nothing about the work is expensive; it
 * is the waiting that is, and the waits can happen at the same time.
 *
 * Two constraints shape the interface:
 *
 *  - **Order is the artifact.** A Storyboard is an *ordered* set of Captures
 *    (CONTEXT.md), and a page whose frames arrived in download order would be
 *    a different document. So this yields strictly in the order given, however
 *    the fetches settle — the caller writes the same loop it wrote when the
 *    fetches were sequential.
 *  - **Memory is bounded too, not just the calls.** The obvious shape — start
 *    everything, cap the calls in flight — finishes holding all 66 images at
 *    once, because a fetch that lands keeps its bytes until the consumer gets
 *    to it. The backend has 512Mi and an uncompressed PDF buffer growing
 *    beside it. So a fetch starts only when an earlier one has been consumed:
 *    at most `ahead` are outstanding, and at most `ahead` results are held.
 *
 * The rejected alternative is `Promise.all` over the whole list, which is one
 * line and unbounded in both senses: 66 simultaneous connections, and every
 * image resident before the first one is drawn.
 */

/**
 * Walks `items` in order, keeping up to `ahead` fetches running.
 *
 * Yields `{ item, value }` — `value` being what `fetchOne(item)` resolved to.
 *
 * `ahead` has no default on purpose: the bound is a claim about the caller's
 * memory and its round trips, and a default here would be a second copy of a
 * number that belongs next to the work it bounds.
 *
 * A failed fetch surfaces when the walk reaches *that* item, not when it
 * fails, so the caller sees failures in the same order it would have seen
 * them fetching one at a time. Fetches still outstanding when the walk ends —
 * because the caller broke out, or because an earlier item threw — are
 * abandoned with their rejections already handled, so a Capture whose bytes
 * are unreadable cannot turn into an unhandled rejection long after the
 * request that asked for it answered 500.
 */
async function* prefetchInOrder(items, fetchOne, { ahead } = {}) {
  // Inverted so `NaN` and `undefined` fail here rather than silently becoming
  // a pool that starts nothing and hangs on the first item.
  if (!(ahead >= 1)) throw new RangeError(`ahead must be at least 1, got ${ahead}`);

  const outstanding = new Map();
  let next = 0;

  const fill = () => {
    while (outstanding.size < ahead && next < items.length) {
      const index = next;
      next += 1;
      // An async IIFE so a `fetchOne` that throws synchronously becomes a
      // rejection like any other, rather than escaping mid-fill and leaving
      // the fetches already started with nobody to await them.
      const fetch = (async () => fetchOne(items[index]))();
      // Handled here, awaited below: this marks the rejection as seen so an
      // abandoned fetch stays quiet, while the `await` still throws for the
      // caller. Without it, `ahead - 1` rejections go unhandled every time a
      // fetch fails.
      fetch.catch(() => {});
      outstanding.set(index, fetch);
    }
  };

  fill();

  for (let index = 0; index < items.length; index += 1) {
    const fetch = outstanding.get(index);
    outstanding.delete(index);
    const value = await fetch;
    // Topped up after the await and before the yield, so the pool is full
    // again while the caller is busy drawing this one.
    fill();
    yield { item: items[index], value };
  }
}

module.exports = { prefetchInOrder };
