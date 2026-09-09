'use strict';

/**
 * Retrying a rate-limited model call (#96).
 *
 * `gemini-3.5-flash` returned `RESOURCE_EXHAUSTED` under rapid repeated calls
 * while 2.5-flash and 2.5-pro succeeded in the same window, and it cleared on
 * retry — rate limiting rather than a quota block (#108's probing). An OCR
 * Report makes up to twenty multimodal calls in a row, which is exactly that
 * burst, and the workers had no backoff at all.
 *
 * Sequential with backoff rather than concurrent: the Report is queued and
 * polled for, so latency costs nothing that matters, and running two calls at
 * once makes the condition being handled more likely rather than less.
 */

const logger = require('./logger');

/** Rate limiting, as opposed to a failure that will fail again identically. */
function isRateLimited(err) {
  const status = err?.status ?? err?.code;
  if (status === 429) return true;
  const text = `${err?.message ?? ''}`;
  return /RESOURCE_EXHAUSTED|rate limit|too many requests/i.test(text);
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Runs `fn`, retrying only a rate-limited rejection.
 *
 * Anything else is rethrown immediately: a 403 or a malformed request fails the
 * same way on the fourth attempt as on the first, and retrying it spends the
 * Customer's money to arrive at the same place more slowly.
 *
 * `sleep` is injectable so tests can prove the retry happened without waiting
 * for it — the delays are real seconds and a suite that lived through them
 * would be encouraged not to test this at all.
 */
async function withRateLimitRetry(fn, {
  attempts = 4, baseMs = 1000, label = 'call', sleep = wait,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRateLimited(err) || attempt === attempts) throw err;
      const delay = baseMs * (2 ** (attempt - 1));
      logger.warn(`[retry] ${label} rate limited (attempt ${attempt}/${attempts}); waiting ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

module.exports = { isRateLimited, withRateLimitRetry };
