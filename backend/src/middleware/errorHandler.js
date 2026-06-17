/**
 * Global error handler  —  must be the LAST app.use() in src/index.js.
 *
 * Catches:
 *   – Firestore transaction errors thrown with an attached .status property
 *   – Unhandled promise rejections forwarded by express-async-errors (or next(err))
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
    // Log 5xx to stderr for Cloud Logging
    console.error(JSON.stringify({
      severity: 'ERROR',
      message,
      stack: err.stack,
      url: req.originalUrl,
    }));
  }

  return res.status(status).json({ error: message });
}

module.exports = { errorHandler };
