'use strict';

/**
 * A simple structured JSON logger.
 * Formats log entries as JSON for Google Cloud Logging, which automatically
 * parses them and maps the `severity` field to the log level in the console.
 */
function logToStdout(severity, message, payload = {}) {
  const entry = {
    severity,
    message,
    ...payload,
    // Add timestamp if not running in GCP (Cloud Logging adds its own)
    ...(process.env.NODE_ENV !== 'production' && { timestamp: new Date().toISOString() })
  };
  
  if (severity === 'ERROR' || severity === 'CRITICAL') {
    process.stderr.write(JSON.stringify(entry) + '\n');
  } else {
    process.stdout.write(JSON.stringify(entry) + '\n');
  }
}

module.exports = {
  debug: (message, payload) => logToStdout('DEBUG', message, payload),
  info: (message, payload) => logToStdout('INFO', message, payload),
  warn: (message, payload) => logToStdout('WARNING', message, payload),
  error: (message, payload) => logToStdout('ERROR', message, payload),
};
