/**
 * The deadline agrees with the timeout it is derived from (#127)
 *
 * `IN_REQUEST_BUDGET_MS` exists because Cloud Run kills a request at
 * `--timeout`, so a row still `queued` long after that cannot have a request
 * behind it. The number is therefore a copy of a number that lives in
 * `cloudbuild.yaml`, and nothing connected the two: raising the deploy timeout
 * to 600s would leave reports being settled as failed at 360s while the
 * request that is writing them is still legitimately running, and every test
 * would stay green.
 *
 * Lesson 60's "never let two places hold the same address", enforced rather
 * than written down — the same argument, and the same shape, as
 * `infra/tests/emulator-port-single-source.test.js` makes for the emulator
 * port. This one lives in the backend suite because that is the suite
 * `cloudbuild.yaml` itself runs.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { IN_REQUEST_BUDGET_MS } = require('../src/lib/reportDeadline');

const CLOUDBUILD = path.join(__dirname, '..', '..', 'cloudbuild.yaml');

/**
 * The `--timeout` the named Cloud Run service actually deploys with.
 *
 * Read positionally rather than with a YAML parser: the file lists two
 * services and the portal's own 10s timeout sits further down the same
 * document, so the service name is what disambiguates them.
 */
function deployTimeoutSeconds(service) {
  const lines = fs.readFileSync(CLOUDBUILD, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `- '${service}'`);
  expect(start).toBeGreaterThan(-1);

  const flag = lines.findIndex((l, i) => i > start && l.trim() === "- '--timeout'");
  expect(flag).toBeGreaterThan(-1);

  const match = /- '(\d+)s'/.exec(lines[flag + 1]);
  expect(match).not.toBeNull();
  return Number(match[1]);
}

describe('IN_REQUEST_BUDGET_MS', () => {
  test('leaves margin past the backend\'s deployed Cloud Run timeout', () => {
    const timeoutMs = deployTimeoutSeconds('thehammer-backend') * 1000;

    // Past it, or a live request gets its own row marked failed underneath it.
    expect(IN_REQUEST_BUDGET_MS).toBeGreaterThan(timeoutMs);
    // Not so far past that a dead row stays believable for an afternoon. Five
    // minutes of margin is the intent; the assertion is what stops the two
    // numbers drifting apart in either direction without anyone choosing it.
    expect(IN_REQUEST_BUDGET_MS).toBeLessThanOrEqual(timeoutMs + 5 * 60_000);
  });

  test('reads the backend service, not the portal deployed beside it', () => {
    // The portal deploys with 10s in the same file. A positional read that
    // drifted onto it would make the assertion above pass for the wrong
    // reason, and this is the only thing that would notice.
    expect(deployTimeoutSeconds('thehammer-backend')).toBe(300);
    expect(deployTimeoutSeconds('thehammer-portal')).toBe(10);
  });
});
