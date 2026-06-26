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

const videoExportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 requests per hour
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.hammerUser?.id || req.ip,
  handler: (_req, res, _next, options) => {
    res.status(options.statusCode).json({
      error: 'Video export rate limit exceeded (5/hr)',
      retryAfter: Math.ceil(options.windowMs / 1000)
    });
  }
});

module.exports = {
  analystReportLimiter,
  videoExportLimiter
};
