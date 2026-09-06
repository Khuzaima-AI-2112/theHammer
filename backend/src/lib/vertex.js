'use strict';

const { GoogleGenAI } = require('@google/genai');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'thehammer';
const LOCATION = process.env.VERTEX_LOCATION || 'northamerica-northeast1';

let aiClient = null;
function getAIClient() {
  if (!aiClient) {
    // `vertexai` is a boolean flag selecting the Vertex backend; `project` and
    // `location` are its siblings, not its contents. Nesting them reads as a
    // truthy flag with no credentials behind it, which the SDK reports only as
    // "Authentication is not set up" at call time (#107).
    aiClient = new GoogleGenAI({ vertexai: true, project: PROJECT_ID, location: LOCATION });
  }
  return aiClient;
}

module.exports = {
  getAIClient,
  PROJECT_ID,
  LOCATION
};
