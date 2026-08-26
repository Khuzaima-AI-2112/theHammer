'use strict';

// What the portal image actually contains — issue #31.
//
// The Dockerfile copied two files and the portal needed five. index.html had
// been split into app.js, styles.css and logo.png, and auth-ext.html — the page
// that completes extension sign-in — was added, and nothing copied any of them.
// Nobody noticed for two months because deploy-portal had been failing since
// June 26, so the portal in production was still the old self-contained build.
//
// These tests model the image's web root from the Dockerfile and .dockerignore
// and assert every asset the HTML asks for is in it. The point is that adding a
// sixth asset cannot quietly repeat this: the model follows `COPY .`, so a new
// file is covered without anyone remembering to extend a list here.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PORTAL_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(PORTAL_DIR, '..');
const WEB_ROOT = '/usr/share/nginx/html';

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

/**
 * The .dockerignore patterns that matter here are bare filenames. Anything more
 * elaborate is reported rather than half-understood, so this file cannot pass by
 * silently ignoring a rule it does not model.
 */
function loadDockerignore() {
  const file = path.join(PORTAL_DIR, '.dockerignore');
  if (!fs.existsSync(file)) return new Set();
  const patterns = read(file)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  for (const p of patterns) {
    assert.ok(!/[*?[\]!]/.test(p) && !p.includes('/'),
      `portal/.dockerignore pattern "${p}" is more than a filename; teach this test about it`);
  }
  return new Set(patterns);
}

/** Every `COPY src dest` in the Dockerfile, as [src, dest]. */
function copyInstructions(dockerfile) {
  return dockerfile
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^COPY\s/i.test(l))
    .map((l) => l.replace(/^COPY\s+/i, '').split(/\s+/))
    .filter((parts) => parts.length === 2);
}

/** Paths removed again by a `RUN rm -f …`, so they are not really in the image. */
function removedPaths(dockerfile) {
  const removed = new Set();
  for (const line of dockerfile.split(/\r?\n/)) {
    const m = line.trim().match(/^RUN\s+rm\s+-f\s+(.+)$/i);
    if (!m) continue;
    for (const p of m[1].split(/\s+/)) removed.add(p.replace(/\\$/, ''));
  }
  return removed;
}

/**
 * The set of filenames nginx will find under /usr/share/nginx/html, derived from
 * the Dockerfile the same way `docker build` would derive it.
 */
function imageWebRoot() {
  const dockerfile = read(PORTAL_DIR, 'Dockerfile');
  const ignored = loadDockerignore();
  const removed = removedPaths(dockerfile);
  const served = new Set();

  for (const [src, dest] of copyInstructions(dockerfile)) {
    if (!dest.startsWith(WEB_ROOT)) continue;

    if (src === '.') {
      // Directories count too: `COPY .` copies portal/tests/ into the web root
      // unless .dockerignore excludes it, and a set of files-only would not see it.
      for (const entry of fs.readdirSync(PORTAL_DIR)) {
        if (ignored.has(entry)) continue;
        served.add(entry);
      }
    } else if (!ignored.has(src)) {
      served.add(path.posix.basename(dest.endsWith('/') ? src : dest));
    }
  }

  for (const p of removed) {
    if (p.startsWith(`${WEB_ROOT}/`)) served.delete(p.slice(WEB_ROOT.length + 1));
  }
  return served;
}

/** Same-origin src=/href= targets in a page — the files it cannot render without. */
function localAssets(html) {
  const refs = new Set();
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const url = m[1];
    if (/^(https?:)?\/\//i.test(url) || /^(data|mailto|blob|#)/i.test(url)) continue;
    const clean = url.split(/[?#]/)[0].replace(/^\.?\//, '');
    if (clean) refs.add(clean);
  }
  return refs;
}

const htmlPages = () =>
  fs.readdirSync(PORTAL_DIR).filter((f) => f.endsWith('.html'));

test('every asset the portal pages reference is in the image', () => {
  const served = imageWebRoot();
  const missing = [];

  for (const page of htmlPages()) {
    if (!served.has(page)) continue;
    for (const asset of localAssets(read(PORTAL_DIR, page))) {
      if (!served.has(asset)) missing.push(`${page} → ${asset}`);
    }
  }

  assert.deepStrictEqual(missing, [],
    `referenced but not copied into the image: ${missing.join(', ')}`);
});

test('every asset referenced also exists in the repository', () => {
  const missing = [];
  for (const page of htmlPages()) {
    for (const asset of localAssets(read(PORTAL_DIR, page))) {
      if (!fs.existsSync(path.join(PORTAL_DIR, asset))) missing.push(`${page} → ${asset}`);
    }
  }
  assert.deepStrictEqual(missing, []);
});

test('auth-ext.html is in the image, because extension sign-in dies without it', () => {
  assert.ok(imageWebRoot().has('auth-ext.html'),
    'the page that receives redirect_uri and returns the ID token is not deployed');
});

test('the test suite is not served from the web root', () => {
  assert.ok(!imageWebRoot().has('tests'),
    'portal/tests/ is published over HTTP; COPY . takes directories too');
});

test('nginx.conf is not served from the web root', () => {
  assert.ok(!imageWebRoot().has('nginx.conf'),
    'the server config is readable over HTTP');
});

test('a missing .html is a 404, not the SPA fallback', () => {
  const conf = read(PORTAL_DIR, 'nginx.conf');

  // The fallback that served the admin portal in place of auth-ext.html.
  assert.match(conf, /location\s*\/\s*\{[^}]*try_files\s+\$uri\s+\$uri\/\s+\/index\.html/,
    'the SPA fallback moved; re-check what it now catches');

  const guards = [...conf.matchAll(/location\s+~\*?\s+([^\s{]+)\s*\{([^}]*)\}/g)]
    .filter(([, , body]) => /try_files\s+\$uri\s+=404/.test(body))
    .map(([, pattern]) => pattern);

  assert.ok(guards.some((p) => /\\\.\[\^\/\]\+\$/.test(p)),
    'no location sends a request naming a file straight to =404');
});

test('the injected backend URL carries no /api prefix', () => {
  const cloudbuild = read(REPO_ROOT, 'cloudbuild.yaml');
  const inject = cloudbuild.match(/sed -i "s\|__BACKEND_API_URL__\|([^"]*)\|g"/);

  assert.ok(inject, 'the inject-backend-url step no longer matches; check cloudbuild.yaml');
  assert.strictEqual(inject[1], '$$BACKEND_URL',
    'the backend mounts every route at the root — see #26 and #31');
});

test('the file the injection rewrites is one the image actually copies', () => {
  const cloudbuild = read(REPO_ROOT, 'cloudbuild.yaml');
  const target = cloudbuild.match(/sed -i "s\|__BACKEND_API_URL__\|[^"]*\|g"\s+(\S+)/);

  assert.ok(target, 'the inject-backend-url step no longer matches; check cloudbuild.yaml');
  const name = path.posix.basename(target[1]);
  assert.ok(imageWebRoot().has(name),
    `cloudbuild rewrites portal/${name}, which never reaches the image`);
});

test('the placeholder the injection looks for is still in app.js', () => {
  assert.match(read(PORTAL_DIR, 'app.js'), /__BACKEND_API_URL__/,
    'nothing for inject-backend-url to replace; the deployed portal would call a literal placeholder');
});
