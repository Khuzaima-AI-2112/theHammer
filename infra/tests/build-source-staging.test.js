'use strict';

// Build source staging — issue #110.
//
// Five Cloud Build source archives, each a full copy of backend/ with its
// node_modules, sat in the Captures bucket from June until 2026-09-14. They
// were not the residue of a stray manual submit: infra/deploy.ps1 named the
// Captures bucket as its staging directory,
//
//   gcloud builds submit ... --gcs-source-staging-dir "gs://$BucketName/source"
//
// with $BucketName defaulting to the Captures bucket, so every run of the
// script put one there. `gcloud builds submit` with no flag stages into
// gs://<project>_cloudbuild/source, which is where build inputs belong.
//
// deploy.ps1 is retired (AGENTS.md rule 5) but still present, so this guards
// every file in the repo rather than the one script: anything that names a
// staging directory names the Cloud Build bucket.
//
// Run with: npm run test:indexes

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { repoFiles } = require('./repo-files');

const REPO = path.join(__dirname, '..', '..');
const SELF = path.relative(REPO, __filename).split(path.sep).join('/');

const BUILD_BUCKET = 'thehammer_cloudbuild';
const CAPTURES_BUCKET = 'thehammer-storage-2026';

// Where a staging flag could be written down: scripts, pipeline config, docs.
const SCANNED = /\.(ps1|sh|ya?ml|js|md|json|cmd)$/i;

/** Every `--gcs-source-staging-dir` value in the repo, with where it is. */
function stagingDirs() {
  const found = [];
  for (const rel of repoFiles()) {
    if (rel === SELF || !SCANNED.test(rel) || rel.includes('node_modules/')) continue;
    const full = path.join(REPO, ...rel.split('/'));
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, 'utf8');
    for (const m of src.matchAll(/--gcs-source-staging-dir[=\s]+["']?([^"'\s]+)/g)) {
      found.push({ rel, value: m[1] });
    }
  }
  return found;
}

test('no file stages build source into the Captures bucket', () => {
  for (const { rel, value } of stagingDirs()) {
    assert.ok(!value.includes(CAPTURES_BUCKET) && !/\$BucketName\b/.test(value),
      `${rel} stages build source into ${value}: a full copy of the repository in the Captures bucket (#110)`);
  }
});

test('every staging directory named is the Cloud Build bucket', () => {
  for (const { rel, value } of stagingDirs()) {
    assert.ok(value.startsWith(`gs://${BUILD_BUCKET}/`),
      `${rel} stages build source into ${value}; build inputs belong in gs://${BUILD_BUCKET}/`);
  }
});
