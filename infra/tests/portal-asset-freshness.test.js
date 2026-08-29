'use strict';

// The portal's cached script.
//
// nginx served every .js and .css with `expires 1y` and `Cache-Control:
// public, immutable`, and index.html loads them under fixed names — plain
// `app.js`, plain `styles.css`, no version and no content hash. index.html
// itself is no-store, so a browser that had ever opened the portal took the new
// markup and kept the old script, for a year.
//
// It surfaced as an Export button calling a function that "is not defined", and
// as #45's project-id fix being absent from a page that had shipped with it
// weeks earlier. Both were the same cause, and a hard reload fixed both.
//
// Nothing else in the repository can catch this. The portal suite reads source,
// and the build's smoke test fetches the container with no cache to hold — the
// defect only exists in a browser that has been here before.
//
// Run with: npm run test:indexes

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

/**
 * The nginx `location` blocks, as { pattern, body } pairs.
 *
 * Deliberately crude: this only has to find which block would answer a request
 * for app.js and read the headers it sets, not model nginx.
 */
function locationBlocks(conf) {
  const blocks = [];
  const re = /location\s+([^{]+?)\s*\{/g;
  let m;
  while ((m = re.exec(conf)) !== null) {
    const start = re.lastIndex;
    const end = conf.indexOf('}', start);
    blocks.push({ pattern: m[1].trim(), body: conf.slice(start, end) });
  }
  return blocks;
}

/** The first block whose regex pattern would match `name`. */
function blockServing(conf, name) {
  return locationBlocks(conf).find(({ pattern }) => {
    const m = pattern.match(/^~\*?\s+(.+)$/);
    if (!m) return false;
    const flags = pattern.startsWith('~*') ? 'i' : '';
    return new RegExp(m[1], flags).test(name);
  });
}

test('the portal loads its script and stylesheet under names that never change', () => {
  const html = read('portal', 'index.html');

  // The premise the cache rule rests on. If someone adds a version or a content
  // hash to these, this test is the place that says the header rule below can
  // then be relaxed back to immutable.
  assert.match(html, /<script src="app\.js"><\/script>/,
    'index.html loads app.js under a fixed name');
  assert.doesNotMatch(html, /app\.js\?[^"]*v=/,
    'app.js carries no cache-busting query, so it must be revalidated instead');
});

test('nginx never serves js or css as immutable', () => {
  const conf = read('portal', 'nginx.conf');
  const block = blockServing(conf, 'app.js');

  assert.ok(block, 'some location block must answer a request for app.js');
  assert.doesNotMatch(block.body, /immutable/,
    'app.js changes on every release under the same name; immutable pins the old one');
  assert.doesNotMatch(block.body, /expires\s+1y/,
    'a year is not a safe cache for a file whose name does not change');
});

test('nginx makes js and css revalidate', () => {
  const conf = read('portal', 'nginx.conf');

  for (const asset of ['app.js', 'styles.css']) {
    const block = blockServing(conf, asset);
    assert.ok(block, `some location block must answer a request for ${asset}`);
    assert.match(block.body, /Cache-Control\s+"(?=[^"]*(?:no-cache|no-store|must-revalidate))/,
      `${asset} must be revalidated before reuse, or a browser keeps the old one`);
  }
});

test('images and fonts may still be cached hard', () => {
  // The other half of the trade: this fix must not turn every asset into a
  // conditional request on every page load.
  const conf = read('portal', 'nginx.conf');
  const block = blockServing(conf, 'logo.png');

  assert.ok(block, 'some location block must answer a request for logo.png');
  assert.match(block.body, /immutable/,
    'images are fixed for the life of the page and should stay cached');
});
