'use strict';

/**
 * A simple structured JSON logger.
 * Formats log entries as JSON for Google Cloud Logging, which automatically
 * parses them and maps the `severity` field to the log level in the console.
 *
 * The payload is normalised before it is merged into the entry. Spreading it
 * directly — which is what this did until #106 — silently destroyed the two
 * things callers most often pass: `{...new Error('x')}` is `{}`, because an
 * Error's message and stack are not own enumerable properties, and a string
 * spreads into `{"0":"F","1":"i",...}`. The first cost a production outage its
 * only diagnostic (lesson 73); the second made every auth failure unreadable.
 */

/**
 * `instanceof Error` is false for an Error that crossed a realm boundary — one
 * thrown by a node internal or a vm context — and those are exactly the errors
 * worth logging. The tag check catches them.
 */
function isError(value) {
  return value instanceof Error || Object.prototype.toString.call(value) === '[object Error]';
}

/**
 * The named fields an Error contributes. `error` rather than `message` because
 * the entry's own `message` is the log line's prefix, and losing that to the
 * error's text would be a different kind of unreadable.
 */
function fieldsForError(err) {
  const fields = { error: err.message, stack: err.stack };
  if (err.name && err.name !== 'Error') fields.name = err.name;
  if (err.code !== undefined) fields.code = err.code;
  if (err.cause !== undefined) fields.cause = isError(err.cause) ? err.cause.message : err.cause;
  return fields;
}

function fieldsForPayload(payload) {
  if (payload === undefined || payload === null) return {};
  if (isError(payload)) return fieldsForError(payload);

  // A plain object is the shape structured logging wants, so its fields still
  // merge into the entry as they always have — except for an Error held in one
  // of them, which would otherwise serialise to `{}` one level further down.
  if (typeof payload === 'object' && !Array.isArray(payload)) {
    const fields = {};
    for (const [key, value] of Object.entries(payload)) {
      fields[key] = isError(value) ? fieldsForError(value) : value;
    }
    return fields;
  }

  // Strings, numbers, booleans and arrays: one named value, never spread.
  return { detail: payload };
}

function logToStdout(severity, message, payload) {
  const entry = {
    severity,
    message,
    ...fieldsForPayload(payload),
    // Add timestamp if not running in GCP (Cloud Logging adds its own)
    ...(process.env.NODE_ENV !== 'production' && { timestamp: new Date().toISOString() })
  };

  let line;
  try {
    line = JSON.stringify(entry) + '\n';
  } catch (err) {
    // A circular or otherwise unserialisable payload must not throw: almost
    // every call site is inside a catch block, so throwing here would replace
    // a logged failure with an unlogged one.
    line = JSON.stringify({
      severity,
      message,
      logError: `payload could not be serialised: ${err.message}`
    }) + '\n';
  }

  if (severity === 'ERROR' || severity === 'CRITICAL') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

module.exports = {
  debug: (message, payload) => logToStdout('DEBUG', message, payload),
  info: (message, payload) => logToStdout('INFO', message, payload),
  warn: (message, payload) => logToStdout('WARNING', message, payload),
  error: (message, payload) => logToStdout('ERROR', message, payload),
};
