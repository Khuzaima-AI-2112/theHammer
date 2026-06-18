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

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status  = err.status || err.statusCode || 500;
  const message = err.message || 'internal server error';

  if (process.env.NODE_ENV !== 'production') {
    console.error('[errorHandler]', err);
  } else if (status >= 500) {
    console.error(JSON.stringify({
      severity: 'ERROR',
      message,
      stack:    err.stack,
      url:      req.originalUrl,
    }));
  }

  // Never send a stack trace to the client
  return res.status(status).json({ error: message });
}

module.exports = { errorHandler };
