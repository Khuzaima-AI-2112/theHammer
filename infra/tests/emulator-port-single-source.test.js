'use strict';

// The Firestore emulator's port — issue #57.
//
// firebase.json starts the emulator on 8085. cloudbuild.yaml told the backend
// suite to reach it on 8080, so nothing answered and every backend test failed
// at step 1 of the pipeline. The port had moved off 8080 in e8cd407 because an
// unrelated local app held it; the one environment where 8080 was free was the
// only one that then broke.
//
// `firebase emulators:exec` exports FIRESTORE_EMULATOR_HOST to the process it
// runs, reading it from firebase.json, so nothing else needs to name the port.
// This asserts firebase.json is the only place that does — lesson 60's "never
// let two places hold the same address", enforced rather than written down.
//
// Run with: npm run test:indexes

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

test('firebase.json is where the emulator port is declared', () => {
  const port = JSON.parse(read('firebase.json')).emulators?.firestore?.port;
  assert.ok(Number.isInteger(port), 'firebase.json must declare emulators.firestore.port');
});

test('cloudbuild.yaml does not pin the emulator host or port', () => {
  // A comment may name the variable to explain why it is absent; only a real
  // assignment counts as pinning it, so comment lines are dropped first.
  const yaml = read('cloudbuild.yaml')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.ok(
    !/FIRESTORE_EMULATOR_HOST\s*=/.test(yaml),
    'cloudbuild.yaml must not set FIRESTORE_EMULATOR_HOST — emulators:exec exports it from firebase.json'
  );
});

test('the test setup falls back to the port firebase.json declares', () => {
  // If the CLI ever stops exporting the variable, the fallback has to agree with
  // the config rather than silently addressing a different port.
  const port = JSON.parse(read('firebase.json')).emulators.firestore.port;
  const env = read('backend', 'tests', 'setup', 'env.js');
  const fallback = env.match(/FIRESTORE_EMULATOR_HOST\s*\|\|\s*'([^']+)'/);
  assert.ok(fallback, 'env.js should keep a literal fallback for FIRESTORE_EMULATOR_HOST');
  assert.strictEqual(
    fallback[1].split(':')[1],
    String(port),
    `env.js falls back to ${fallback[1]} but firebase.json declares port ${port}`
  );
});
