'use strict';

/**
 * A Report whose request died still says so (#127).
 *
 * Two routes write a `reports` row before they start work and update it after:
 * `POST /storyboards/:id/finalize` (`processing`, then the PDF) and
 * `POST /storyboards/:id/video` (`queued`, then ~200s of speech synthesis).
 * Writing the row first is deliberate and right — it is what #122 asked for,
 * and what makes a failure leave a record instead of silence.
 *
 * It is only half a record. Cloud Run kills a request that outruns
 * `--timeout 300s` (`cloudbuild.yaml`) without running anything's `catch`, so
 * the `await reportRef.update({ status: 'error' })` in those handlers never
 * runs. The row keeps its opening status for ever, the portal polls it for
 * ever, and `queued` with nothing behind it looks exactly like `queued` about
 * to succeed.
 *
 * So a row that is worked on inside a request carries **its own deadline**.
 * Past that, no request can still be running: the platform has already killed
 * it. A read then settles the row to `error`, lazily — the same shape
 * `lib/shotstack.js` uses to catch up a finished render, and for the same
 * stated reason (Rule 7: there is no queue, no worker and no webhook here to
 * notice on our behalf, so the poll the portal already does is the trigger).
 *
 * **What this is not.** Where those 200s of synthesis *should* live is #127's
 * open question and is untouched here — moving it is an architecture decision
 * with real infrastructure behind it. This is the half that is true whichever
 * way that goes: work that lives inside a request has a deadline, and a row
 * that outlives it is not still in flight.
 *
 * Only a writer that knows its work is bounded by its own request stamps the
 * deadline. A row without one is left alone, which is what keeps every row
 * written before this existed, and the worker-dispatched `metrics` and `ocr`
 * types, out of its way.
 *
 * **"Overdue", not "abandoned".** CONTEXT.md already gives *Abandoned Upload*
 * a precise and unrelated meaning — a Capture whose bytes never arrived — and
 * a second sense of the word in a glossary this deliberate would cost more
 * than the name is worth.
 *
 * **Known limitation.** Settling happens on a read *of the row*, so a surface
 * that never reads rows never settles any. The dashboard's pending tile
 * (`routes/admin/dashboard.js`) is a Firestore `count()` aggregate over
 * `status in ['queued','processing']`, which cannot settle what it counts: an
 * overdue row keeps inflating that number until some read path touches it.
 * Narrowing the aggregate would need a composite index on
 * (status, mustFinishBy) that this repo has not deployed, and Rule 7 says not
 * to write code that assumes one. Left as it is, deliberately and on the
 * record.
 */

const logger = require('./logger');

/**
 * How long after the request started a row can no longer be in flight.
 *
 * `cloudbuild.yaml` deploys the backend with `--timeout 300s`, so 300s is the
 * longest a request can live. The extra minute is margin, not caution about
 * the platform: a row settled at exactly 300s would race the request's own
 * closing write, and the two disagreeing about what happened is a worse
 * failure than noticing a minute later. Detection is for a human reading the
 * Reports tab; a minute costs them nothing.
 */
const IN_REQUEST_BUDGET_MS = 300_000 + 60_000;

/** Statuses that are still waiting for something. Anything else is settled. */
const UNFINISHED = new Set(['queued', 'processing']);

function nowISO() { return new Date().toISOString(); }

/**
 * The deadline to stamp on a row whose work happens inside this request.
 *
 * Cleared (set to `null`) at the moment the work leaves the request — a video
 * row reaching `processing` with a Shotstack render id is the one case, and
 * from there its liveness is `refreshVideoReportStatus`'s to judge.
 */
function mustFinishBy() {
  return new Date(Date.now() + IN_REQUEST_BUDGET_MS).toISOString();
}

/**
 * Settles a row whose request cannot still be running, and returns what the
 * caller should answer with.
 *
 * Returns `data` untouched in every other case, so a caller can wrap every
 * row it reads without asking which kind it is — the same contract
 * `refreshVideoReportStatus` has, and it composes with it.
 *
 * A failed write is swallowed: this runs inside `GET /admin/reports`, and
 * turning a listing into a 500 over a best-effort catch-up trades "one row
 * reads wrong" for "the Reports tab is broken".
 */
async function settleIfOverdue(reportRef, data) {
  if (!UNFINISHED.has(data?.status)) return data;

  // Work that names something outside this system is not this module's to
  // judge, whatever the deadline says. The video route clears the deadline as
  // it records the render id, but those are one write and a request can die
  // between Shotstack accepting the render and that write landing — leaving a
  // row with both. Settling it would report a render that is running as one
  // that never started, and throw away the only id that could find it again.
  if (data?.shotstackRenderId) return data;

  const deadline = Date.parse(data?.mustFinishBy ?? '');
  // NaN for a missing, null or malformed stamp — none of which is a deadline
  // that has passed. A row nobody promised to finish is not a row that broke.
  if (!Number.isFinite(deadline) || Date.now() <= deadline) return data;

  const update = {
    status: 'error',
    error: 'The request generating this report did not finish, and is no longer running.',
    updatedAt: nowISO(),
  };

  try {
    await reportRef.update(update);
  } catch (err) {
    logger.error(`[Reports] could not settle overdue report ${reportRef.id}:`, err);
    return data;
  }

  return { ...data, ...update };
}

module.exports = { mustFinishBy, settleIfOverdue, IN_REQUEST_BUDGET_MS };
