'use strict';

// A stable extension id — issue #36.
//
// Chrome derives an unpacked extension's id from the SHA-256 of its public key,
// and with no "key" in the manifest it invents one from the *folder path*. So
// every machine that loads this extension gets a different id, and the backend's
// CORS allowlist and the portal's sign-in redirect both have to name it. #54
// mitigated that by letting EXTENSION_ID hold a list, which grows by one per
// developer, needs a production deploy per addition, and can never be pruned
// because nobody can say whose an id is.
//
// Declaring the public key fixes the id for everyone. These tests assert the
// three facts that keeps true, and — more usefully — that the id the manifest
// produces is the same one the deployed allowlist trusts. Rotating the key
// without redeploying the new id is the failure this file exists to catch: it
// breaks every extension call with a CORS error, which looks nothing like a
// configuration problem from the browser (#31).
//
// Run with: npm run test:extension

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'extension', 'manifest.json'), 'utf8'));

/**
 * The id Chrome will give an extension declaring this public key.
 *
 * Chrome takes the SHA-256 of the DER-encoded SubjectPublicKeyInfo, keeps the
 * first 16 bytes, and renders them in a base-16 alphabet of 'a'..'p' rather
 * than '0'..'f' — an id is 32 letters, never a digit. Reimplemented here rather
 * than imported so the test is independent of whatever generated the key.
 */
function extensionIdFor(base64Key) {
  const der = Buffer.from(base64Key, 'base64');
  const digest = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...digest].map((c) => String.fromCharCode(parseInt(c, 16) + 0x61)).join('');
}

test('the manifest declares a public key, so the id does not come from the folder path', () => {
  assert.ok(manifest.key, 'extension/manifest.json has no "key" field');
});

test('the key is a well-formed RSA public key Chrome can read', () => {
  const der = Buffer.from(manifest.key, 'base64');
  // Round-trips: a truncated or PEM-wrapped value decodes to bytes but is not
  // an importable key, and Chrome's failure for that is a silent id change.
  const imported = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  assert.strictEqual(imported.asymmetricKeyType, 'rsa');
  assert.strictEqual(imported.asymmetricKeyDetails.modulusLength, 2048);
});

test('the derived id is the one the backend and the portal are deployed to trust', () => {
  const derived = extensionIdFor(manifest.key);
  assert.match(derived, /^[a-p]{32}$/);

  // cloudbuild.yaml is the single source of both consumers: it is interpolated
  // into the backend's EXTENSION_ID and substituted into portal/auth-ext.html.
  // Read rather than duplicated, so this cannot pass against a stale copy.
  const cloudbuild = fs.readFileSync(path.join(REPO, 'cloudbuild.yaml'), 'utf8');
  const line = cloudbuild.match(/^\s*_EXTENSION_IDS:\s*'([^']*)'/m);
  assert.ok(line, 'cloudbuild.yaml declares no _EXTENSION_IDS substitution');

  const deployed = line[1].split(/[\s,]+/).filter(Boolean);
  assert.ok(
    deployed.includes(derived),
    `cloudbuild.yaml trusts [${deployed.join(', ')}] but the manifest key derives ${derived}`
  );
});
