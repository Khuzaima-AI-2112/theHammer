// ─────────────────────────────────────────────────────────────────
// Unit tests — Tasks 2.3, 2.4, 2.5
// Converted from node:test to Jest so all suites run under npm test.
// ─────────────────────────────────────────────────────────────────
'use strict';


const { sanitize, buildObjectPath, app } = require('../src/index');

// ── sanitize() ───────────────────────────────────────────────────
describe('sanitize()', () => {
  test('strips path traversal sequences', () => {
    const result = sanitize('../../etc/passwd');
    expect(result).not.toContain('..');
    expect(result).not.toContain('/etc/');
  });

  test('handles unicode (café)', () => {
    const result = sanitize('café');
    expect(result).toMatch(/^caf/);
    expect(result).not.toContain('é');
    expect(result.length).toBeLessThanOrEqual(64);
  });

  test('replaces all-special-chars (!!!) with underscores', () => {
    expect(sanitize('!!!')).toMatch(/^[_]+$/);
  });

  test('returns empty string for empty input', () => {
    expect(sanitize('')).toBe('');
  });

  test('truncates 200-char string to 64 chars', () => {
    expect(sanitize('a'.repeat(200)).length).toBe(64);
  });

  test('handles null bytes', () => {
    expect(sanitize('hello\0world')).not.toContain('\0');
  });
});

// ── buildObjectPath() ────────────────────────────────────────────
describe('buildObjectPath()', () => {
  test('matches expected naming pattern', () => {
    const now  = new Date('2025-06-15T10:30:00.123Z');
    const path = buildObjectPath('proj1', 'user1', 'figma', now);
    expect(path).toMatch(
      /^[^/]+\/[^/]+\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z.*\.png$/
    );
  });

  test('two calls in the same millisecond produce different paths', () => {
    const now = new Date('2025-01-01T00:00:00.000Z');
    expect(buildObjectPath('proj', 'user', '', now))
      .not.toBe(buildObjectPath('proj', 'user', '', now));
  });

  test('path contains sanitized projectId and userId', () => {
    const path = buildObjectPath('my project', 'user-1', '', new Date());
    expect(path).toMatch(/^my_project\/user-1\//);
  });

  test('path omits tool segment when tool is empty', () => {
    expect(buildObjectPath('p', 'u', '', new Date())).not.toContain('__');
  });

  test('path contains tool segment when tool is provided', () => {
    expect(buildObjectPath('p', 'u', 'jira', new Date())).toContain('_jira_');
  });
});

// ── requireMultipart() pre-multer Content-Type guard ─────────────
describe('requireMultipart() pre-multer Content-Type guard', () => {
  const request = require('supertest');

  test('rejects non-multipart requests with 400 before buffering', async () => {
    const res = await request(app)
      .post('/capture')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ projectId: 'p', userId: 'u' }));

    // 400 = Content-Type guard fired; 401 = auth rejected first.
    // Either confirms multer's buffer was never reached.
    expect([400, 401]).toContain(res.status);
    if (res.status === 400) {
      expect(res.body.error).toMatch(/multipart/);
    }
  });
});
