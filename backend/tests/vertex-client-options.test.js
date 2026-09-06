/**
 * #107 — the Vertex client is constructed with the wrong options shape
 *
 * `getAIClient()` used to pass `{ vertexai: { project, location } }`. `vertexai`
 * is a boolean flag and `project`/`location` are its siblings, so the object
 * form was truthy enough to select the Vertex branch and then left the client
 * with no credentials to use. Every narrative the product has ever generated
 * fell back to raw metrics because of it, and nothing failed loudly: #8's
 * graceful degradation completes the report either way.
 *
 * Nothing caught it because every other suite mocks `@google/genai` wholesale,
 * so the options object never reaches the real SDK. These tests assert on the
 * arguments the constructor was handed, which is the one observation the mock
 * still permits.
 *
 * Offline like the rest of the suite, and lighter than most of it: lib/vertex
 * requires only the SDK, so no emulator or fixture is involved.
 */

'use strict';

jest.mock('@google/genai', () => require('./helpers/genaiMock').createGenAIMock());

/**
 * getAIClient() memoises its client in a module-level variable, and PROJECT_ID
 * and LOCATION are read once at require time. Observing a construction — or a
 * different environment — therefore needs a fresh module registry rather than a
 * cleared mock. resetModules() re-runs the jest.mock factory too, so the
 * constructor handle is re-required alongside lib/vertex itself.
 */
function loadVertex() {
  jest.resetModules();
  const { GoogleGenAI } = require('@google/genai');
  const vertex = require('../src/lib/vertex');
  return { GoogleGenAI, ...vertex };
}

describe('#107 — the options handed to GoogleGenAI', () => {
  const ORIGINAL_LOCATION = process.env.VERTEX_LOCATION;

  afterEach(() => {
    if (ORIGINAL_LOCATION === undefined) delete process.env.VERTEX_LOCATION;
    else process.env.VERTEX_LOCATION = ORIGINAL_LOCATION;
  });

  test('vertexai is the boolean true, not a container for project and location', () => {
    const { GoogleGenAI, getAIClient } = loadVertex();

    getAIClient();

    expect(GoogleGenAI).toHaveBeenCalledTimes(1);
    expect(GoogleGenAI.mock.calls[0][0].vertexai).toBe(true);
  });

  test('project and location are siblings of vertexai, where the SDK reads them', () => {
    const { GoogleGenAI, getAIClient, PROJECT_ID, LOCATION } = loadVertex();

    getAIClient();

    expect(GoogleGenAI.mock.calls[0][0]).toEqual({
      vertexai: true,
      project: PROJECT_ID,
      location: LOCATION
    });
  });

  test('VERTEX_LOCATION defaults to northamerica-northeast1', () => {
    delete process.env.VERTEX_LOCATION;
    const { GoogleGenAI, getAIClient } = loadVertex();

    getAIClient();

    expect(GoogleGenAI.mock.calls[0][0].location).toBe('northamerica-northeast1');
  });

  test('VERTEX_LOCATION overrides the default when set', () => {
    process.env.VERTEX_LOCATION = 'us-central1';
    const { GoogleGenAI, getAIClient } = loadVertex();

    getAIClient();

    expect(GoogleGenAI.mock.calls[0][0].location).toBe('us-central1');
  });

  test('the client is constructed once and then reused', () => {
    const { GoogleGenAI, getAIClient } = loadVertex();

    expect(getAIClient()).toBe(getAIClient());
    expect(GoogleGenAI).toHaveBeenCalledTimes(1);
  });
});
