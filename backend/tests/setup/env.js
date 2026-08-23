'use strict';

/**
 * Environment for the backend suite. Runs before any test module loads, so the
 * app sees these values at require time.
 *
 * The suite is offline by design: Firestore goes to the emulator, and Cloud
 * Storage is mocked. Nothing here should ever reach a real Google endpoint.
 *
 * METADATA_SERVER_DETECTION deserves a note. The Cloud Storage client resolves
 * Application Default Credentials by probing the GCE metadata server. On a
 * developer machine nothing answers that address, so the connection attempt
 * stays pending: Jest finishes the run, waits on the open socket, and prints
 * "Jest did not exit one second after the test run has completed", which hangs
 * CI until the job times out. `--detectOpenHandles` cannot name it — a pending
 * outbound connection inside the auth library is not a libuv handle Jest tracks;
 * it shows up as ConnectWrap and TCPSocketWrap in getActiveResourcesInfo().
 *
 * Consequence to know about: a future test that genuinely needs real credential
 * resolution must not use this setup file, or it will fail with an opaque
 * no-credentials error rather than resolving ADC.
 */
process.env.NODE_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.METADATA_SERVER_DETECTION = 'none';
