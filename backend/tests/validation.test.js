// ─────────────────────────────────────────────────────────────────
// Unit tests — Tasks 2.3, 2.4, 2.5
// Run with: node --test tests/**/*.test.js  (Node 20 built-in runner)
// ─────────────────────────────────────────────────────────────────
'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { sanitize, buildObjectPath } = require('../src/index');

// ── Task 2.4: sanitize() adversarial inputs ──────────────────────
describe('sanitize()', () => {
  it('strips path traversal sequences', () => {
    const result = sanitize('../../etc/passwd');
    assert.ok(!result.includes('..'), `expected no ".." in: ${result}`);
    assert.ok(!result.includes('/etc/'), `expected no "/etc/" in: ${result}`);
  });

  it('handles unicode (café)', () => {
    const result = sanitize('café');
    // é is outside the safe set; the ASCII part and _ remain
    assert.ok(result.startsWith('caf'), `expected to start with "caf": ${result}`);
    assert.ok(!result.includes('é'), `expected no é in: ${result}`);
    assert.ok(result.length <= 64);
  });

  it('replaces all-special-chars (!!! ) with underscores', () => {
    const result = sanitize('!!!');
    assert.match(result, /^[_]+$/, `expected only underscores: ${result}`);
  });

  it('returns empty string for empty input', () => {
    assert.equal(sanitize(''), '');
  });

  it('truncates 200-char string to 64 chars', () => {
    const long = 'a'.repeat(200);
    const result = sanitize(long);
    assert.equal(result.length, 64);
  });

  it('handles null bytes', () => {
    const result = sanitize('hello\0world');
    assert.ok(!result.includes('\0'), 'null byte should be stripped');
  });
});

// ── Task 2.5: buildObjectPath() ──────────────────────────────────
describe('buildObjectPath()', () => {
  it('matches expected naming pattern', () => {
    const now = new Date('2025-06-15T10:30:00.123Z');
    const path = buildObjectPath('proj1', 'user1', 'figma', now);
    // e.g. proj1/user1/2025-06-15T10-30-00-123Z_figma_<rand>.png
    assert.match(
      path,
      /^[^/]+\/[^/]+\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z.*\.png$/,
      `path format unexpected: ${path}`
    );
  });

  it('two calls in the same millisecond produce different paths', () => {
    const now = new Date('2025-01-01T00:00:00.000Z');
    const p1 = buildObjectPath('proj', 'user', '', now);
    const p2 = buildObjectPath('proj', 'user', '', now);
    assert.notEqual(p1, p2, 'paths must differ even at same millisecond (random suffix)');
  });

  it('path contains sanitized projectId and userId', () => {
    const path = buildObjectPath('my project', 'user-1', '', new Date());
    // spaces → underscores in sanitize()
    assert.ok(path.startsWith('my_project/user-1/'), `path prefix unexpected: ${path}`);
  });

  it('path omits tool segment when tool is empty', () => {
    const path = buildObjectPath('p', 'u', '', new Date());
    // Should not have double underscore from empty tool
    assert.ok(!path.includes('__'), `unexpected double underscore: ${path}`);
  });

  it('path contains tool segment when tool is provided', () => {
    const path = buildObjectPath('p', 'u', 'jira', new Date());
    assert.ok(path.includes('_jira_'), `expected tool segment in path: ${path}`);
  });
});
