'use strict';

/**
 * The internal worker secret — one resolution, no literal (#105).
 *
 * `POST /worker/reports` and `POST /worker/ocr` accept a caller presenting
 * `x-internal-secret`, and `POST /reports/generate` is the caller that
 * presents it. Both sides used to read `process.env.INTERNAL_SECRET ||
 * 'dev-secret'`, which never fails and never logs: an unconfigured deployment
 * is indistinguishable from a configured one, right up until somebody reads
 * the fallback out of the repository. #104 confirmed that was the deployed
 * state — `INTERNAL_SECRET` was named neither in `cloudbuild.yaml` nor on the
 * live revision — so production ran on a published four-word string, on a
 * service deployed `--allow-unauthenticated`.
 *
 * The stakes are not "an unauthorised report gets generated". The internal
 * path is deliberately *exempt* from the Workspace ownership check #104 added,
 * because a genuine internal caller has no `hammerUser` to scope against. A
 * guessable secret therefore walks around the tenancy check with one header.
 *
 * **Unset means refused, never a known value.** In production an absent
 * `INTERNAL_SECRET` resolves to `null` and the internal path stops
 * authenticating anyone; callers fall through to `requireAdmin` like any other
 * request. That is the loud failure the `||` was hiding.
 *
 * **Outside production the process generates its own.** Local development
 * would otherwise need a variable set before report generation worked at all,
 * and a setup step nobody performs is how the next `'dev-secret'` gets added.
 * A random 32-byte value is not a fallback in the sense that matters: it is
 * unguessable, and it is written nowhere. It works locally only because the
 * caller and the checker are the same process.
 *
 * That last sentence is exactly why production is not allowed to generate one.
 * Cloud Run runs up to five instances behind one URL (`cloudbuild.yaml`), and
 * `reports/generate` reaches the worker over `BACKEND_URL` — so a per-process
 * secret would authenticate only when the request happened to land back on the
 * instance that invented it. Provisioning is `infra/add-internal-secret.ps1`.
 *
 * Resolved once and cached: a secret that changed under a running server would
 * refuse the requests that server had just issued.
 */

const crypto = require('crypto');
const logger = require('./logger');

/** `undefined` until first resolved; `null` is itself an answer. */
let resolved;

function resolveInternalSecret() {
  if (resolved !== undefined) return resolved;

  const configured = process.env.INTERNAL_SECRET;
  if (configured) {
    resolved = configured;
    return resolved;
  }

  if (process.env.NODE_ENV === 'production') {
    logger.error(
      '[internal-secret] INTERNAL_SECRET is not set. The internal worker path is ' +
      'refused until it is; report generation will fail. Provision it with ' +
      'infra/add-internal-secret.ps1 and redeploy.'
    );
    resolved = null;
    return resolved;
  }

  resolved = crypto.randomBytes(32).toString('hex');
  logger.info(
    '[internal-secret] INTERNAL_SECRET is not set; generated one for this process. ' +
    'Fine for local development, where the caller and the worker are the same process.'
  );
  return resolved;
}

module.exports = { resolveInternalSecret };
