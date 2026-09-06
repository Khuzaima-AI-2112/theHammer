'use strict';

// Firestore composite indexes — issue #43.
//
// GET /admin/projects returned 500 the moment a Workspace had a Project:
// FAILED_PRECONDITION, because `where(workspaceId).orderBy(createdAt desc)` has
// no index. Four of the eight index-requiring queries in the backend had none,
// and the failure only appears once real data exists, so an empty environment
// looks healthy.
//
// This reads the queries out of the route sources and fails when one has no
// matching index, so the audit that had to be done by hand does not have to be
// done again.
//
// Run with: npm run test:indexes

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const ROUTES = path.join(REPO, 'backend', 'src', 'routes');

const INDEXES = JSON.parse(fs.readFileSync(path.join(REPO, 'firestore.indexes.json'), 'utf8')).indexes;

/** collections.USERS -> 'users' */
function collectionNames() {
  const src = fs.readFileSync(path.join(REPO, 'backend', 'src', 'lib', 'collections.js'), 'utf8');
  const out = {};
  for (const m of src.matchAll(/(\w+):\s*'([^']+)'/g)) out[m[1]] = m[2];
  return out;
}

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
}

/**
 * Every query in the routes that needs a composite index. Two shapes qualify:
 *
 *   1. equality filters plus an `orderBy` — the original case, #43
 *   2. equality filters plus an *inequality* on a different field — added for
 *      #101, whose scoped Dashboard counts are exactly this and have no
 *      `orderBy` to be noticed by
 *
 * Shape 2 was invisible to this audit until #101. `where(workspaceId ==)` with
 * `where(memberCount >)` needs an index just as much as an ordered query does,
 * and Firestore fails it identically — FAILED_PRECONDITION, only once the
 * collection has data. The emulator serves both without any index, so no local
 * run will tell you either is missing (lesson 68).
 *
 * A query with neither an orderBy nor an inequality needs no composite index
 * and is skipped.
 */
const INEQUALITY_OPS = ['<', '<=', '>', '>=', '!='];

function indexRequiringQueries() {
  const names = collectionNames();
  const found = [];

  for (const file of jsFiles(ROUTES)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/db\.collection\(collections\.(\w+)\)/g)) {
      const slice = src.slice(m.index, m.index + src.slice(m.index).indexOf(';') + 1);
      const equality = [...slice.matchAll(/\.where\('([^']+)',\s*'=='/g)].map((w) => w[1]);
      if (equality.length === 0) continue;

      const order = slice.match(/\.orderBy\('([^']+)',\s*'(asc|desc)'\)/);
      if (order) {
        found.push({
          collection: names[m[1]] || m[1],
          equality,
          orderBy: order[1],
          direction: order[2] === 'asc' ? 'ASCENDING' : 'DESCENDING',
          where: path.relative(REPO, file).split(path.sep).join('/')
        });
        continue;
      }

      // An inequality sorts by its own field, so the index it needs has that
      // field last and ascending — the same shape an orderBy would produce.
      const inequality = [...slice.matchAll(/\.where\('([^']+)',\s*'([^']+)'/g)]
        .find((w) => INEQUALITY_OPS.includes(w[2]));
      if (!inequality) continue;

      found.push({
        collection: names[m[1]] || m[1],
        equality,
        orderBy: inequality[1],
        direction: 'ASCENDING',
        where: path.relative(REPO, file).split(path.sep).join('/')
      });
    }
  }
  return found;
}

/** Does any declared index serve this query? */
function served(q) {
  return INDEXES.some((ix) => {
    if (ix.collectionGroup !== q.collection) return false;
    if (ix.fields.length !== q.equality.length + 1) return false;
    const last = ix.fields[ix.fields.length - 1];
    if (last.fieldPath !== q.orderBy || last.order !== q.direction) return false;
    const heads = ix.fields.slice(0, -1).map((f) => f.fieldPath).sort();
    return JSON.stringify(heads) === JSON.stringify([...q.equality].sort());
  });
}

const QUERIES = indexRequiringQueries();

test('the audit actually found the queries, so a silent pass is not possible', () => {
  assert.ok(QUERIES.length >= 6,
    `expected to parse several index-requiring queries, found ${QUERIES.length}`);
});

test('every query that needs a composite index has one', () => {
  const missing = QUERIES.filter((q) => !served(q));

  const detail = missing.map((q) =>
    `  ${q.collection}: where(${q.equality.join(', ')}) orderBy(${q.orderBy} ${q.direction})  — ${q.where}`
  ).join('\n');

  assert.deepStrictEqual(missing, [],
    `these queries will fail with FAILED_PRECONDITION once the collection has data:\n${detail}\n\n` +
    'Add the index to firestore.indexes.json.');
});

test('there is exactly one index file, so the wrong one cannot be edited', () => {
  const stray = path.join(REPO, 'infra', 'firestore.indexes.json');

  assert.ok(!fs.existsSync(stray),
    'infra/firestore.indexes.json is deployed by nothing — firebase.json names the root file');
});

test('firebase.json deploys the file these tests check', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase.json'), 'utf8'));

  assert.strictEqual(cfg.firestore.indexes, 'firestore.indexes.json');
});
