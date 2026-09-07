'use strict';

// Bucket lifecycle — issue #113 (parent #112).
//
// ADR 0010 fixed the answer at "captures are kept indefinitely". The setup
// scripts nonetheless applied a 90-day delete rule, and the verification
// scripts asserted that the rule was *present* — so a passing verify run was
// confirming the opposite of what the product decided.
//
// The scripts also named `thehammer-screenshots`, a bucket that has been
// deleted. Everything that reads or writes captures uses
// `thehammer-storage-2026`, so the next setup run would have created the dead
// bucket back into existence and applied the delete rule to it.
//
// These read the scripts as text, because the thing under test is what a
// person running `bash infra/setup.sh` would cause to happen, and no GCP
// project can be stood up in a unit test to observe it.
//
// Run with: npm run test:indexes

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const INFRA = path.join(__dirname, '..');

const SETUP = ['setup.sh', 'setup.ps1'];
const VERIFY = ['verify.sh', 'verify.ps1'];
const ALL = [...SETUP, ...VERIFY];

const read = (name) => fs.readFileSync(path.join(INFRA, name), 'utf8');

/** The bucket every backend reader and writer actually uses. */
const BUCKET = 'thehammer-storage-2026';
const DEAD_BUCKET = 'thehammer-screenshots';

test('the lifecycle rule definition is gone', () => {
  assert.ok(!fs.existsSync(path.join(INFRA, 'lifecycle.json')),
    'infra/lifecycle.json declares a 90-day Delete rule that ADR 0010 rejected');
});

test('no script applies a lifecycle file to the bucket', () => {
  for (const name of ALL) {
    const src = read(name);

    assert.ok(!/--lifecycle-file/.test(src),
      `${name} still applies a lifecycle rule; captures are kept indefinitely (ADR 0010)`);
    assert.ok(!/lifecycle\.json/.test(src),
      `${name} still references the deleted infra/lifecycle.json`);
  }
});

test('the setup scripts name the bucket that is actually in use', () => {
  for (const name of SETUP) {
    const src = read(name);

    assert.ok(src.includes(BUCKET),
      `${name} does not name ${BUCKET}`);
    assert.ok(!src.includes(DEAD_BUCKET),
      `${name} names ${DEAD_BUCKET}, which has been deleted — a setup run would recreate it`);
  }
});

// The whole defect was two names for one bucket. Four scripts agreeing among
// themselves would not have caught it — the name they disagreed with lives in
// the deploy path and in Cloud Build (lesson 60: never let two places hold the
// same address without something that checks they still match).
test('everything that names the capture bucket names the same one', () => {
  const REPO = path.join(INFRA, '..');
  const elsewhere = {
    'infra/deploy.ps1': null,
    'cloudbuild.yaml': null,
    'backend/src/lib/shotstack.js': null
  };

  for (const rel of Object.keys(elsewhere)) {
    const src = fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf8');

    assert.ok(src.includes(BUCKET),
      `${rel} does not name ${BUCKET}`);
    assert.ok(!src.includes(DEAD_BUCKET),
      `${rel} names ${DEAD_BUCKET}, which has been deleted`);
  }
});

test('the verification scripts check the same bucket the setup scripts create', () => {
  for (const name of VERIFY) {
    const src = read(name);

    assert.ok(src.includes(BUCKET),
      `${name} does not name ${BUCKET}`);
    assert.ok(!src.includes(DEAD_BUCKET),
      `${name} verifies ${DEAD_BUCKET}, which has been deleted`);
  }
});

// The inversion. A verify run must now fail if someone re-applies a rule by
// hand, which is the only way one can come back.
test('the verification scripts assert the bucket carries no lifecycle rule', () => {
  for (const name of VERIFY) {
    const src = read(name);

    assert.ok(/no lifecycle rule/i.test(src),
      `${name} does not check that the bucket is free of a lifecycle rule`);
    assert.ok(!/["']Bucket has lifecycle rule["']/.test(src),
      `${name} still asserts a lifecycle rule is present — the opposite of what is wanted`);
  }
});

/**
 * The body of the 0.7c check, however the script has been reflowed — from the
 * line naming it up to the end of its block, so an assertion here is about
 * what the check does rather than where its lines sit.
 */
function lifecycleCheck(name) {
  const src = read(name);
  const from = src.search(/no lifecycle rule/i);
  assert.notStrictEqual(from, -1, `${name} has no 0.7c check to read`);

  const rest = src.slice(from);
  const end = name.endsWith('.ps1') ? rest.indexOf('\n}') : rest.indexOf('\n\n');
  return rest.slice(0, end === -1 ? undefined : end);
}

// A check that reads "no lifecycle rule" but greps for its presence would pass
// on a bucket that has one, which is the bug being fixed rather than a fix.
test('the bash check fails when a rule is present', () => {
  assert.match(lifecycleCheck('verify.sh'), /!\s*grep -q rule/,
    'the 0.7c command must be negated so a re-applied rule fails the run');
});

test('the PowerShell check fails when a rule is present', () => {
  assert.match(lifecycleCheck('verify.ps1'), /-notmatch 'rule'/,
    'the 0.7c check must be negated so a re-applied rule fails the run');
});

// Both verify scripts discard the describe's stderr, so a gcloud that cannot
// answer — wrong project, no credentials, bucket gone — prints nothing. Nothing
// does not match 'rule', so a naive negation reports a bucket nobody can even
// see as free of a rule. The check has to fail closed.
test('the bash check fails when gcloud cannot answer', () => {
  assert.match(lifecycleCheck('verify.sh'), /\$\(gcloud[\s\S]*?\)\s*&&/,
    'the describe must succeed before its output is judged, or an error reads as a pass');
});

test('the PowerShell check fails when gcloud cannot answer', () => {
  assert.match(lifecycleCheck('verify.ps1'), /\$LASTEXITCODE -eq 0/,
    'the describe must succeed before its output is judged, or an error reads as a pass');
});
