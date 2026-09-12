/**
 * A Report whose request died still says so (#127)
 *
 * `POST /storyboards/:id/video` writes its `reports` row `queued` before it
 * starts 200s of work, and `POST /storyboards/:id/finalize` writes `processing`
 * before it assembles. Both are deliberate — a row written first is a row that
 * survives a failure (#122). But Cloud Run kills a request that outruns
 * `--timeout 300s` without running anything's `catch`, so the row is left in
 * its opening status for ever, and `queued` with nothing working on it is
 * indistinguishable from `queued` about to succeed. The Analyst is told
 * nothing, and polls a row that will never change.
 *
 * The fix this file covers is deliberately *not* the architecture: where the
 * 200s of synthesis should live is #127's open question. This is the half that
 * is true whatever that answer turns out to be — a row that carries its own
 * deadline, and reads that settle one that outlived it.
 *
 * Pure: the deadline arithmetic and the decision to write, with a stub ref.
 * No Firestore, no routes.
 */
'use strict';

const {
  mustFinishBy,
  settleIfOverdue,
  IN_REQUEST_BUDGET_MS,
} = require('../src/lib/reportDeadline');

/** A `reports` doc ref that records the update instead of making one. */
function stubRef() {
  const updates = [];
  return { updates, update: async (patch) => { updates.push(patch); } };
}

const agesAgo = () => new Date(Date.now() - IN_REQUEST_BUDGET_MS - 60_000).toISOString();

describe('mustFinishBy', () => {
  test('is the deploy timeout past now, with room for the request to lose', () => {
    const before = Date.now();
    const deadline = Date.parse(mustFinishBy());

    expect(deadline).toBeGreaterThanOrEqual(before + IN_REQUEST_BUDGET_MS);
    expect(deadline).toBeLessThanOrEqual(Date.now() + IN_REQUEST_BUDGET_MS + 1000);
  });

  test('leaves margin past the 300s Cloud Run kills a request at', () => {
    // A row settled at exactly 300s would race the request still writing its
    // own `done`, and the two would disagree about what happened.
    expect(IN_REQUEST_BUDGET_MS).toBeGreaterThan(300_000);
  });
});

describe('settleIfOverdue', () => {
  test('writes error over a `queued` row that outlived its deadline', async () => {
    const ref = stubRef();
    const data = {
      reportType: 'storyboard-video', status: 'queued', mustFinishBy: agesAgo(),
    };

    const settled = await settleIfOverdue(ref, data);

    expect(ref.updates).toHaveLength(1);
    expect(ref.updates[0].status).toBe('error');
    // The message has to say this was never finished, not that it failed:
    // nothing reported an error, which is the whole problem being fixed.
    expect(ref.updates[0].error).toMatch(/did not finish/i);
    expect(settled.status).toBe('error');
    expect(settled.reportType).toBe('storyboard-video');
  });

  test('and over a `processing` row, which is what finalize leaves behind', async () => {
    const ref = stubRef();
    const data = { reportType: 'storyboard', status: 'processing', mustFinishBy: agesAgo() };

    const settled = await settleIfOverdue(ref, data);

    expect(settled.status).toBe('error');
    expect(ref.updates[0].updatedAt).toEqual(expect.any(String));
  });

  test('leaves a row whose deadline has not passed alone', async () => {
    const ref = stubRef();
    const data = {
      reportType: 'storyboard', status: 'processing',
      mustFinishBy: new Date(Date.now() + 60_000).toISOString(),
    };

    expect(await settleIfOverdue(ref, data)).toBe(data);
    expect(ref.updates).toHaveLength(0);
  });

  test('leaves a finished row alone, however long ago it finished', async () => {
    for (const status of ['done', 'error']) {
      const ref = stubRef();
      const data = { reportType: 'storyboard', status, mustFinishBy: agesAgo() };

      expect(await settleIfOverdue(ref, data)).toBe(data);
      expect(ref.updates).toHaveLength(0);
    }
  });

  test('leaves a row carrying no deadline alone', async () => {
    // Every `reports` row written before this existed, and every row whose
    // work does not live inside the request that asked for it — the
    // worker-dispatched `metrics` and `ocr` types. A missing deadline is not
    // an expired one; only a writer that knows its own budget stamps it.
    const ref = stubRef();
    const data = { reportType: 'ocr', status: 'queued', createdAt: agesAgo() };

    expect(await settleIfOverdue(ref, data)).toBe(data);
    expect(ref.updates).toHaveLength(0);
  });

  test('leaves a row alone once the work has left the request', async () => {
    // A video row reaching `processing` with a Shotstack render id has handed
    // the work to Shotstack, where a render legitimately takes minutes. Its
    // liveness is lib/shotstack.js's to judge, not this module's — so the
    // route clears the deadline at that transition, and a cleared deadline
    // must read as no deadline rather than as the epoch.
    const ref = stubRef();
    const data = {
      reportType: 'storyboard-video', status: 'processing',
      shotstackRenderId: 'render-abc', mustFinishBy: null,
    };

    expect(await settleIfOverdue(ref, data)).toBe(data);
    expect(ref.updates).toHaveLength(0);
  });

  test('an unparseable deadline is not treated as expired', async () => {
    const ref = stubRef();
    const data = { reportType: 'storyboard', status: 'queued', mustFinishBy: 'not a date' };

    expect(await settleIfOverdue(ref, data)).toBe(data);
    expect(ref.updates).toHaveLength(0);
  });

  test('a write that fails does not take the read down with it', async () => {
    // This runs inside GET /admin/reports. A settle that throws would turn a
    // listing into a 500 — replacing "one row reads wrong" with "the Reports
    // tab is broken", which is a worse trade for a best-effort catch-up.
    const ref = {
      update: async () => { throw new Error('Firestore unavailable'); },
    };
    const data = { reportType: 'storyboard', status: 'queued', mustFinishBy: agesAgo() };

    expect(await settleIfOverdue(ref, data)).toBe(data);
  });

  test('a fresh deadline from mustFinishBy is not already expired', async () => {
    const ref = stubRef();
    const data = {
      reportType: 'storyboard', status: 'processing', mustFinishBy: mustFinishBy(),
    };

    expect(await settleIfOverdue(ref, data)).toBe(data);
    expect(ref.updates).toHaveLength(0);
  });

  test('a row naming a live render is left alone even with an expired deadline', async () => {
    // The narrow window the clearing write does not cover: Shotstack accepted
    // the render, and the request died before `mustFinishBy: null` landed. The
    // render is genuinely running, so settling it would report live work as
    // failed and discard the one id that could find it again.
    const ref = stubRef();
    const data = {
      reportType: 'storyboard-video', status: 'processing',
      shotstackRenderId: 'render-abc', mustFinishBy: agesAgo(),
    };

    expect(await settleIfOverdue(ref, data)).toBe(data);
    expect(ref.updates).toHaveLength(0);
  });
});
