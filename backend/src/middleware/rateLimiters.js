'use strict';

const rateLimit = require('express-rate-limit');

const analystReportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 requests per hour
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.hammerUser?.id || req.ip,
  handler: (_req, res, _next, options) => {
    res.status(options.statusCode).json({
      error: 'Analyst report rate limit exceeded (10/hr)',
      retryAfter: Math.ceil(options.windowMs / 1000)
    });
  }
});

// Sprint 22 wrote this as `videoExportLimiter` and never wired it to a route.
// The route that now uses it exports a ZIP of Captures, not a video, so the
// name and the message follow the surface that exists rather than the one that
// was planned. Nothing referenced the old name.
const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 requests per hour
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.hammerUser?.id || req.ip,
  // An export suite makes more than five requests as one user, and a limiter
  // firing part-way through would fail tests that are about ordering and
  // permissions. Only this limiter skips; analystReportLimiter is left alone.
  skip: () => process.env.NODE_ENV === 'test',
  handler: (_req, res, _next, options) => {
    res.status(options.statusCode).json({
      error: 'Export rate limit exceeded (5/hr)',
      retryAfter: Math.ceil(options.windowMs / 1000)
    });
  }
});

module.exports = {
  analystReportLimiter,
  exportLimiter
};
