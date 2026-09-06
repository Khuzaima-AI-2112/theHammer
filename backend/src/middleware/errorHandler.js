/**
 * Global error handler  —  MUST be the last app.use() in src/index.js.
 *
 * Catches:
 *   – Firestore transaction errors thrown with an attached .status property
 *   – Any unhandled async error forwarded via next(err)
 *
 * Never leaks stack traces to the client in production.
 */

'use strict';

const logger = require('../lib/logger');


// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status  = err.status || err.statusCode || 500;
  const message = err.message || 'internal server error';

  if (process.env.NODE_ENV !== 'production') {
    logger.error('[errorHandler]', err);
  } else if (status >= 500) {
    // This used to hand JSON.stringify(...) to the logger as the *message*,
    // which encoded a whole entry inside the entry's own message field — so
    // production 500s arrived as one escaped string that Cloud Logging could
    // not index on any of its fields (#106).
    logger.error('[errorHandler]', { error: err, url: req.originalUrl, status });
  }

  // Never send a stack trace to the client
  return res.status(status).json({ error: message });
}

module.exports = { errorHandler };
