'use strict';

/**
 * Environment for the backend suite. Runs before any test module loads, so the
 * app sees these values at require time.
 *
 * The suite is offline by design: Firestore goes to the emulator, and Cloud
 * Storage is mocked. Nothing here should ever reach a real Google endpoint.
 *
 * No METADATA_SERVER_DETECTION here, and why it used to be (#19). A real
 * Cloud Storage client resolves Application Default Credentials by probing the
 * GCE metadata server. On a developer machine nothing answers, the connection
 * stays pending, and Jest prints "Jest did not exit one second after the test
 * run has completed". `--detectOpenHandles` cannot name it: the pending
 * connection shows up only as ConnectWrap and TCPSocketWrap in
 * getActiveResourcesInfo(). This file set METADATA_SERVER_DETECTION=none to
 * contain that, because index.js and seven modules it loads each built a
 * client at require time: 8 real clients in every suite that loaded the app
 * without mocking '@google-cloud/storage', 72 across the suite.
 *
 * The clients are now built on first use (src/lib/storage.js), and a run that
 * counted every real Storage and GoogleGenAI construction found none, so there
 * was nothing left for the setting to contain. It also meant a test needing
 * real credential resolution could not use this file. That restriction is gone.
 *
 * The way this comes back: a suite that reaches a bucket (a signed URL, a
 * Capture upload, an export) without
 * `jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock())`
 * builds a real client. Mock it. Don't restore the setting to hide it.
 */
process.env.NODE_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085';

// firebase-admin's initializeApp() resolves a project id from the environment,
// and with no ADC on the machine it throws 'Unable to detect a Project Id'. The
// emulator accepts any id; this one matches the project the fixtures' wipe
// endpoint addresses, so the app and clearDatabase share a namespace.
//
// `demo-hammer` is not a Google Cloud project and must never become one.
// AGENTS.md permits this folder exactly two live targets, `thehammer` and
// `hammer-dev` (ADR-0006); this id is addressable only because
// FIRESTORE_EMULATOR_HOST is set above, which routes every Firestore call to
// the emulator. If that line is ever removed, this one becomes a request to a
// project that does not exist rather than a silent success.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-hammer';

// The Purge refuses to run without a bucket to empty (#114): a destructive
// route that falls back to a hardcoded name would delete objects from a bucket
// nobody named. Production sets this in cloudbuild.yaml; the suite sets it here,
// and Cloud Storage is the double, so nothing addressable is behind it.
process.env.GCS_BUCKET = process.env.GCS_BUCKET || 'test-bucket';
