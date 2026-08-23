'use strict';

/**
 * The Cloud Storage client resolves Application Default Credentials by probing
 * the GCE metadata server. On a developer machine nothing answers that address,
 * so the connection attempt stays pending: Jest finishes the run, waits on the
 * open socket, and prints "Jest did not exit one second after the test run has
 * completed", which hangs CI until the job times out.
 *
 * `--detectOpenHandles` cannot name this one — a pending outbound connection
 * inside the auth library is not a libuv handle that Jest tracks. It shows up as
 * ConnectWrap and TCPSocketWrap in process.getActiveResourcesInfo().
 *
 * The suite runs offline against the emulator by design and never needs real
 * credentials, so the probe is switched off here.
 */
process.env.METADATA_SERVER_DETECTION = 'none';
