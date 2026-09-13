/**
 * A Dockerfile's re-pin command names the image its FROM line pins (#21)
 *
 * Both Dockerfiles pin their base image to a digest and document, in a
 * comment, the command that fetches the next one (lesson 8: a digest comes
 * from the registry, never from memory). The tag is therefore written twice,
 * and nothing connected the two. backend/Dockerfile moved `FROM` to
 * node:22-alpine while its comment still pulled node:20-alpine, so re-pinning
 * exactly as the file said would have resolved a Node 20 digest: a silent
 * major-version downgrade of the deployed runtime.
 *
 * Lives in the backend suite because that is the suite `cloudbuild.yaml` runs
 * (same reasoning as report-deadline-matches-deploy.test.js).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');

/**
 * The tag in `FROM <tag>@sha256:…`, and the tags the one-line re-pin command
 * pulls and inspects. Any part that is not found is null, so a comment
 * reworded into another shape fails the check rather than passing it.
 */
function readPins(source) {
  const from = /^FROM\s+([^@\s]+)@sha256:[0-9a-f]{64}\s*$/m.exec(source);
  const repin = /^#.*docker pull\s+(\S+)\s+&&\s+docker inspect\s.*\s(\S+)\s*$/m.exec(source);
  return {
    fromTag: from ? from[1] : null,
    pullTag: repin ? repin[1] : null,
    inspectTag: repin ? repin[2] : null
  };
}

describe.each(['backend/Dockerfile', 'portal/Dockerfile'])('%s', (file) => {
  test('re-pins the same image tag that FROM pins', () => {
    const { fromTag, pullTag, inspectTag } = readPins(fs.readFileSync(path.join(REPO, file), 'utf8'));

    expect(fromTag).not.toBeNull();
    expect(pullTag).toBe(fromTag);
    // Both halves of the command: pulling one tag and inspecting another would
    // report the digest of whichever image happened to be cached.
    expect(inspectTag).toBe(fromTag);
  });
});

// The regexes are the whole guard, so they are tested against the drift they
// exist to catch, not only against files that happen to agree (lesson 83).
describe('readPins', () => {
  const digest = 'a'.repeat(64);

  test('sees a comment that names a different major', () => {
    const drifted = [
      "# To re-pin: docker pull node:20-alpine && docker inspect --format='{{index .RepoDigests 0}}' node:20-alpine",
      `FROM node:22-alpine@sha256:${digest}`
    ].join('\n');

    expect(readPins(drifted)).toEqual({
      fromTag: 'node:22-alpine',
      pullTag: 'node:20-alpine',
      inspectTag: 'node:20-alpine'
    });
  });

  test('tells the pulled tag from the inspected one', () => {
    const halfUpdated = [
      "# docker pull node:22-alpine && docker inspect --format='{{index .RepoDigests 0}}' node:20-alpine",
      `FROM node:22-alpine@sha256:${digest}`
    ].join('\n');

    const pins = readPins(halfUpdated);
    expect(pins.pullTag).toBe('node:22-alpine');
    expect(pins.inspectTag).toBe('node:20-alpine');
  });

  test('finds nothing when either half is missing', () => {
    const noCommand = readPins(`FROM node:22-alpine@sha256:${digest}`);
    expect(noCommand.pullTag).toBeNull();
    expect(noCommand.inspectTag).toBeNull();
    expect(readPins('# docker pull x && docker inspect --format=y x').fromTag).toBeNull();
  });
});
