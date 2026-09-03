/**
 * Storyboard drafts (#85)  —  curate and persist a Capture selection
 *
 * POST  /admin/projects/:id/storyboards  → find-or-create the Project's
 *                                           open draft
 * GET   /admin/storyboards/:id           → fetch a draft
 * PATCH /admin/storyboards/:id           → update checkboxes/order/notes
 *
 * A draft is pre-populated once, at creation, with every Capture the
 * Project has at that moment, oldest first — the same ordering
 * GET /admin/projects/:id/export already uses. That fixed set is also what
 * a PATCH's captureIds are validated against: curating a draft never has to
 * reconcile with Captures that land after the draft was opened, and no
 * Capture can be added to a Storyboard through this route that wasn't part
 * of the Project when the draft was created (#85's scope — see spec).
 *
 * AI narrative generation (#86)  —  POST /admin/storyboards/:id/narrative
 * takes an Analyst-typed prompt, sends the draft's included/ordered Captures
 * (as multimodal gs:// image references) plus their notes plus the prompt to
 * Vertex AI Gemini via the shared getAIClient() (lib/vertex.js), and writes
 * the result back onto the draft — not into the `reports` collection, since
 * this draft has not been finalized into a report yet (ADR 0013 covers the
 * eventual PDF/video finalization, which does become a `reports` doc; the
 * narrative that feeds it does not need to).
 *
 * Narrative review/edit (#87)  —  PATCH /admin/storyboards/:id/narrative lets
 * an Analyst correct the generated text by hand. It only accepts an edit once
 * a narrative exists (narrativeText is non-null, i.e. status has reached
 * `done` at least once) — there is nothing sensible to edit before that, so a
 * PATCH on a draft with no narrative yet is rejected rather than silently
 * writing into a field the rest of the flow doesn't expect populated yet. A
 * hand edit only moves aside when the Analyst explicitly triggers
 * regeneration (POST, above) — nothing else overwrites it.
 *
 * Audio input (#88) and finalizing into a PDF (#89) are separate tickets and
 * do not live here.
 *
 * Auth: requireAnalyst, not requireAdmin like exports.js/activity.js — #85's
 * own acceptance criteria call for Analyst-and-above, matching the gate
 * reports.js already uses. It admits Admin too, since `admin` (4) outranks
 * `analyst` (3) in ROLE_HIERARCHY.
 */

'use strict';

const express = require('express');
const { Timestamp } = require('firebase-admin/firestore');
const { Storage } = require('@google-cloud/storage');
const logger = require('../../lib/logger');
const { db } = require('../../lib/firestore');
const { requireAnalyst } = require('../../middleware/requireAuth');
const { getAIClient } = require('../../lib/vertex');
const collections = require('../../lib/collections');

const router = express.Router();

const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET || 'thehammer-storage-2026';

// Prompts are typed by hand on one draft, not machine-generated — 4000
// characters is generous headroom without inviting a pasted document.
const MAX_PROMPT_LENGTH = 4000;

// A hand-edited narrative is still hand-typed text, just longer — generous
// headroom for a multi-slide narrative without inviting a pasted document.
const MAX_NARRATIVE_LENGTH = 20000;

// Same lifetime as the Activity view's thumbnails (activity.js) — the
// curation screen is the same kind of "look at pictures for a while" UI.
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

function nowISO() { return new Date().toISOString(); }

function isoOf(value) {
  return value instanceof Timestamp ? value.toDate().toISOString() : value;
}

async function makeSignedUrl(gcsPath) {
  if (!gcsPath) return null;
  try {
    const [url] = await storage.bucket(BUCKET).file(gcsPath).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + SIGNED_URL_TTL_MS,
    });
    return url;
  } catch (_) {
    // Non-fatal: the portal degrades to showing no thumbnail for this row.
    return null;
  }
}

function serializeDraft(snap) {
  const d = snap.data();
  return {
    id: snap.id,
    projectId: d.projectId,
    status: d.status,
    captures: [...(d.captures ?? [])].sort((a, b) => a.order - b.order),
    narrativeStatus: d.narrativeStatus ?? null,
    narrativePrompt: d.narrativePrompt ?? null,
    narrativeText: d.narrativeText ?? null,
    narrativeError: d.narrativeError ?? null,
    createdAt: isoOf(d.createdAt),
    updatedAt: isoOf(d.updatedAt),
    schemaVersion: d.schemaVersion ?? 1,
  };
}

/** Attach a signed thumbnail URL to each Capture in a serialized draft. */
async function enrichWithSignedUrls(draft) {
  if (draft.captures.length === 0) return draft;

  const refs = draft.captures.map((c) => db.collection(collections.UPLOADS).doc(c.captureId));
  const snaps = await db.getAll(...refs);
  const uploadById = {};
  snaps.forEach((s) => { if (s.exists) uploadById[s.id] = s.data(); });

  const signedUrls = await Promise.all(
    draft.captures.map((c) => {
      const upload = uploadById[c.captureId];
      return makeSignedUrl(upload?.gcsPath ?? upload?.path ?? null);
    })
  );

  return {
    ...draft,
    captures: draft.captures.map((c, i) => ({ ...c, signedUrl: signedUrls[i] })),
  };
}

router.post('/projects/:id/storyboards', requireAnalyst, async (req, res, next) => {
  try {
    const projectId = req.params.id;

    const projSnap = await db.collection(collections.PROJECTS).doc(projectId).get();
    if (!projSnap.exists) {
      return res.status(404).json({ error: 'project not found' });
    }
    if (projSnap.data().workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'Forbidden: Project belongs to another workspace' });
    }

    // Resuming an open draft, not starting over — this is what makes
    // "Build Storyboard" safe to click again after leaving mid-curation.
    const existing = await db.collection(collections.STORYBOARD_DRAFTS)
      .where('projectId', '==', projectId)
      .where('status', '==', 'draft')
      .limit(1)
      .get();

    if (!existing.empty) {
      const draft = await enrichWithSignedUrls(serializeDraft(existing.docs[0]));
      return res.status(200).json(draft);
    }

    // Queried DESC and reversed in memory, not queried ASC directly — same
    // reasoning as GET /admin/projects/:id/export: only a
    // (projectId ASC, uploadedAt DESC) composite index is deployed
    // (firestore.indexes.json), and an ASC query would need one that isn't.
    const uploadsSnap = await db.collection(collections.UPLOADS)
      .where('projectId', '==', projectId)
      .orderBy('uploadedAt', 'desc')
      .get();
    const oldestFirst = uploadsSnap.docs.reverse();

    const captures = oldestFirst.map((d, i) => ({
      captureId: d.id,
      order: i + 1,
      included: true,
      note: '',
    }));

    const now = nowISO();
    const ref = db.collection(collections.STORYBOARD_DRAFTS).doc();
    await ref.set({
      projectId,
      workspaceId: req.hammerUser.workspaceId,
      status: 'draft',
      captures,
      createdBy: req.hammerUser.id,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });

    const snap = await ref.get();
    const draft = await enrichWithSignedUrls(serializeDraft(snap));
    return res.status(201).json(draft);
  } catch (err) { next(err); }
});

router.get('/storyboards/:id', requireAnalyst, async (req, res, next) => {
  try {
    const snap = await db.collection(collections.STORYBOARD_DRAFTS).doc(req.params.id).get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'storyboard draft not found' });
    }
    if (snap.data().workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'Forbidden: draft belongs to another workspace' });
    }
    const draft = await enrichWithSignedUrls(serializeDraft(snap));
    return res.json(draft);
  } catch (err) { next(err); }
});

router.patch('/storyboards/:id', requireAnalyst, async (req, res, next) => {
  try {
    const ref = db.collection(collections.STORYBOARD_DRAFTS).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'storyboard draft not found' });
    }
    const existing = snap.data();
    if (existing.workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'Forbidden: draft belongs to another workspace' });
    }

    const incoming = req.body?.captures;
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return res.status(400).json({ error: 'captures must be a non-empty array' });
    }

    // Only Captures the draft was created with can be curated — adding a
    // new Capture to a Storyboard is not something this route does.
    const knownIds = new Set((existing.captures ?? []).map((c) => c.captureId));
    const seen = new Set();
    const nextCaptures = [];

    for (const entry of incoming) {
      const { captureId, order, included, note } = entry ?? {};
      if (!knownIds.has(captureId)) {
        return res.status(400).json({ error: `unknown captureId: ${captureId}` });
      }
      if (seen.has(captureId)) {
        return res.status(400).json({ error: `duplicate captureId: ${captureId}` });
      }
      if (!Number.isInteger(order) || order < 1) {
        return res.status(400).json({ error: `captureId ${captureId}: order must be a positive integer` });
      }
      seen.add(captureId);
      nextCaptures.push({
        captureId,
        order,
        included: Boolean(included),
        note: typeof note === 'string' ? note.slice(0, 2000) : '',
      });
    }

    if (seen.size !== knownIds.size) {
      return res.status(400).json({ error: 'captures must include every Capture the draft was created with' });
    }

    // Two Captures cannot both claim the same slide number — "reorder by
    // slide number" only means something if the numbers form one sequence.
    const orders = nextCaptures.map((c) => c.order);
    if (new Set(orders).size !== orders.length) {
      return res.status(400).json({ error: 'captures must not repeat an order value' });
    }

    await ref.update({ captures: nextCaptures, updatedAt: nowISO() });

    const updatedSnap = await ref.get();
    const draft = await enrichWithSignedUrls(serializeDraft(updatedSnap));
    return res.json(draft);
  } catch (err) { next(err); }
});

/**
 * Builds the multimodal Gemini request from a draft: the prompt, then each
 * *included* Capture in slide order as a gs:// image reference, with its note
 * (if any) as the text part immediately after it. Excluded Captures are not
 * sent — the AI only sees what the Analyst curated.
 *
 * No per-Capture tagging step exists anywhere in this — the AI receives the
 * ordered images and notes and infers its own structure.
 *
 * Exported so tests can assert on the request shape directly, without a
 * mocked AI client or the timing of an async generation run.
 */
async function buildNarrativeRequest(draft, prompt) {
  const included = [...draft.captures]
    .filter((c) => c.included)
    .sort((a, b) => a.order - b.order);

  const parts = [{ text: prompt }];

  if (included.length > 0) {
    const refs = included.map((c) => db.collection(collections.UPLOADS).doc(c.captureId));
    const snaps = await db.getAll(...refs);
    const uploadById = {};
    snaps.forEach((s) => { if (s.exists) uploadById[s.id] = s.data(); });

    for (const c of included) {
      const upload = uploadById[c.captureId];
      const gcsPath = upload?.gcsPath ?? upload?.path ?? null;
      if (gcsPath) {
        parts.push({ fileData: { mimeType: 'image/png', fileUri: `gs://${BUCKET}/${gcsPath}` } });
      }
      if (c.note) {
        parts.push({ text: `Slide ${c.order} note: ${c.note}` });
      }
    }
  }

  return { contents: [{ role: 'user', parts }] };
}

/**
 * Runs the generation and writes the outcome back onto the draft. Not
 * awaited by the route — the portal polls GET /admin/storyboards/:id for the
 * narrativeStatus this writes, the same "queue, then poll" shape the Reports
 * pipeline uses (ADR 0013), without routing through the `reports` collection
 * or worker itself.
 */
async function generateNarrative(draftId, prompt) {
  const ref = db.collection(collections.STORYBOARD_DRAFTS).doc(draftId);
  try {
    await ref.update({ narrativeStatus: 'generating', updatedAt: nowISO() });

    const snap = await ref.get();
    const draft = serializeDraft(snap);

    const projSnap = await db.collection(collections.PROJECTS).doc(draft.projectId).get();
    const modelId = projSnap.data()?.llmModel || 'gemini-1.5-flash';

    const request = await buildNarrativeRequest(draft, prompt);
    const client = getAIClient();
    const resp = await client.models.generateContent({ model: modelId, ...request });

    await ref.update({
      narrativeStatus: 'done',
      narrativeText: resp.text,
      narrativeError: null,
      updatedAt: nowISO(),
    });
  } catch (err) {
    // Surfaced as a status on the draft, not a silently-swallowed rejection
    // and not a "done" status with garbage text.
    logger.error(`[Storyboard Narrative] generation failed for draft ${draftId}:`, err);
    await ref.update({
      narrativeStatus: 'error',
      narrativeError: err.message,
      updatedAt: nowISO(),
    }).catch((updateErr) => {
      logger.error(`[Storyboard Narrative] failed to record error status for draft ${draftId}:`, updateErr);
    });
  }
}

router.post('/storyboards/:id/narrative', requireAnalyst, async (req, res, next) => {
  try {
    const ref = db.collection(collections.STORYBOARD_DRAFTS).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'storyboard draft not found' });
    }
    if (snap.data().workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'Forbidden: draft belongs to another workspace' });
    }

    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({ error: `prompt must be ${MAX_PROMPT_LENGTH} characters or fewer` });
    }

    await ref.update({
      narrativeStatus: 'queued',
      narrativePrompt: prompt,
      narrativeText: null,
      narrativeError: null,
      updatedAt: nowISO(),
    });

    generateNarrative(req.params.id, prompt).catch((err) => {
      logger.error(`[Storyboard Narrative] unhandled error for draft ${req.params.id}:`, err);
    });

    const queuedSnap = await ref.get();
    return res.status(202).json(await enrichWithSignedUrls(serializeDraft(queuedSnap)));
  } catch (err) { next(err); }
});

router.patch('/storyboards/:id/narrative', requireAnalyst, async (req, res, next) => {
  try {
    const ref = db.collection(collections.STORYBOARD_DRAFTS).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'storyboard draft not found' });
    }
    const existing = snap.data();
    if (existing.workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'Forbidden: draft belongs to another workspace' });
    }

    // Nothing to correct before a narrative has ever finished generating —
    // an edit here would write into a field the rest of the flow doesn't
    // expect populated yet, so it's refused explicitly rather than accepted.
    if (existing.narrativeText == null) {
      return res.status(400).json({ error: 'draft has no generated narrative to edit yet' });
    }

    const narrativeText = req.body?.narrativeText;
    if (typeof narrativeText !== 'string') {
      return res.status(400).json({ error: 'narrativeText must be a string' });
    }
    if (narrativeText.length > MAX_NARRATIVE_LENGTH) {
      return res.status(400).json({ error: `narrativeText must be ${MAX_NARRATIVE_LENGTH} characters or fewer` });
    }

    await ref.update({ narrativeText, updatedAt: nowISO() });

    const updatedSnap = await ref.get();
    const draft = await enrichWithSignedUrls(serializeDraft(updatedSnap));
    return res.json(draft);
  } catch (err) { next(err); }
});

router.buildNarrativeRequest = buildNarrativeRequest;
router.generateNarrative = generateNarrative;

module.exports = router;
