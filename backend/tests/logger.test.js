/**
 * #106 — the logger must preserve what it is handed
 *
 * `logToStdout` spread its payload straight into the entry. Two consequences,
 * both of which cost real diagnosis time:
 *
 *   - `{...new Error('boom')}` is `{}`, because message, stack and name are not
 *     own enumerable properties. Every `logger.error(msg, err)` call logged the
 *     prefix and dropped the cause. That is how #105's aftermath produced
 *     `[Reports] Failed to trigger worker:` with nothing after it, and the real
 *     cause — a U+FEFF in a secret — had to be recovered by reading bytes out
 *     of Secret Manager instead. Lesson 73.
 *   - A string spreads into its characters, so `logger.error(msg, err.message)`
 *     logged `{"0":"F","1":"i",...}`.
 *
 * An object payload must keep merging into the entry: that is what structured
 * logging in Cloud Logging wants, and it is the shape the logger was designed
 * for even though no call site used it before this ticket.
 *
 * These tests assert on the parsed entry rather than on the call, because the
 * defect was one of serialisation — the call always looked right.
 */

'use strict';

const logger = require('../src/lib/logger');

/** Captures the single line a logger call writes, parsed back from JSON. */
function capture(fn) {
  const lines = { stdout: [], stderr: [] };
  const out = jest.spyOn(process.stdout, 'write').mockImplementation((s) => { lines.stdout.push(s); return true; });
  const err = jest.spyOn(process.stderr, 'write').mockImplementation((s) => { lines.stderr.push(s); return true; });
  try {
    fn();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  const written = [...lines.stdout, ...lines.stderr];
  expect(written).toHaveLength(1);
  return { raw: written[0], entry: JSON.parse(written[0]), lines };
}

describe('#106 — an Error payload', () => {
  test('is recorded with its message and stack, not discarded as {}', () => {
    const { entry } = capture(() => logger.error('[Reports] Failed to trigger worker:', new Error('boom')));

    expect(entry.message).toBe('[Reports] Failed to trigger worker:');
    expect(entry.error).toBe('boom');
    expect(typeof entry.stack).toBe('string');
    expect(entry.stack).toContain('boom');
  });

  test('keeps a code when the Error carries one', () => {
    // The BOM bug surfaced as ERR_INVALID_CHAR from fetch. The code is often
    // the most searchable part of the failure, so it must survive.
    const err = new TypeError('Invalid character in header content');
    err.code = 'ERR_INVALID_CHAR';

    const { entry } = capture(() => logger.error('[Reports] Failed to trigger worker:', err));

    expect(entry.code).toBe('ERR_INVALID_CHAR');
    expect(entry.name).toBe('TypeError');
  });

  test('keeps a cause when the Error carries one', () => {
    const err = new Error('outer', { cause: new Error('inner') });

    const { entry } = capture(() => logger.error('[x]', err));

    expect(entry.cause).toBe('inner');
  });

  test('is recognised even when it comes from another realm', () => {
    // Errors thrown by node internals or by a vm context fail `instanceof`.
    const foreign = Object.create(Error.prototype);
    Object.defineProperty(foreign, Symbol.toStringTag, { value: 'Error' });
    const err = new Error('cross-realm');
    Object.setPrototypeOf(err, Object.getPrototypeOf(foreign));

    const { entry } = capture(() => logger.error('[x]', err));

    expect(entry.error).toBe('cross-realm');
  });
});

describe('#106 — a string payload', () => {
  test('is one value, not split into character-indexed keys', () => {
    const { entry } = capture(() => logger.error('[Auth] Token verification failed:', 'Firebase ID token has expired'));

    expect(entry.detail).toBe('Firebase ID token has expired');
    expect(entry['0']).toBeUndefined();
    expect(Object.keys(entry)).not.toContain('1');
  });

  test('applies to other primitives too, which also spread into nothing useful', () => {
    expect(capture(() => logger.info('[x]', 42)).entry.detail).toBe(42);
    expect(capture(() => logger.info('[x]', true)).entry.detail).toBe(true);
  });

  test('applies to an array, which would otherwise be index-keyed as well', () => {
    const { entry } = capture(() => logger.warn('[x]', ['a', 'b']));

    expect(entry.detail).toEqual(['a', 'b']);
    expect(entry['0']).toBeUndefined();
  });
});

describe('#106 — an object payload keeps today\'s behaviour', () => {
  test('its fields merge into the entry', () => {
    const { entry } = capture(() => logger.error('[errorHandler]', { status: 400, url: '/v1/uploads' }));

    expect(entry.status).toBe(400);
    expect(entry.url).toBe('/v1/uploads');
    expect(entry.message).toBe('[errorHandler]');
  });

  test('an Error nested in it is serialised rather than merged as {}', () => {
    const { entry } = capture(() => logger.error('[x]', { reportId: 'r1', error: new Error('nested') }));

    expect(entry.reportId).toBe('r1');
    expect(entry.error).toMatchObject({ error: 'nested' });
    expect(typeof entry.error.stack).toBe('string');
  });

  test('no payload at all logs just the message', () => {
    const { entry } = capture(() => logger.info('[x] plain'));

    expect(entry.message).toBe('[x] plain');
    expect(entry.severity).toBe('INFO');
  });
});

describe('#106 — the entry stays machine-readable', () => {
  test('is a single line of valid JSON', () => {
    const { raw } = capture(() => logger.error('[x]', new Error('boom')));

    // The stack is multi-line; JSON.stringify must escape it rather than emit it.
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.trimEnd()).not.toContain('\n');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test.each([
    ['debug', 'DEBUG', 'stdout'],
    ['info', 'INFO', 'stdout'],
    ['warn', 'WARNING', 'stdout'],
    ['error', 'ERROR', 'stderr'],
  ])('%s carries severity %s on %s', (method, severity, stream) => {
    const { entry, lines } = capture(() => logger[method]('[x]'));

    expect(entry.severity).toBe(severity);
    expect(lines[stream]).toHaveLength(1);
  });

  test('a payload that cannot be serialised still produces a usable entry', () => {
    // A circular payload used to throw inside the logger — which, since almost
    // every call sits in a catch block, would replace a logged failure with an
    // unlogged one.
    const circular = { name: 'loop' };
    circular.self = circular;

    const { entry } = capture(() => logger.error('[x] circular', circular));

    expect(entry.severity).toBe('ERROR');
    expect(entry.message).toBe('[x] circular');
    expect(entry.logError).toMatch(/could not be serialised/i);
  });
});
