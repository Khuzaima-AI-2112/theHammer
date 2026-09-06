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
 * Recorded audio as an alternate prompt input (#88)  —
 * POST /admin/storyboards/:id/narrative/audio uploads a short recording,
 * transcribes it via Vertex AI Gemini, and feeds the transcript through
 * queueNarrativeGeneration() — the exact function POST .../narrative (above)
 * calls with a typed prompt. There is no separate audio-driven generation
 * path, only an alternate way to arrive at the prompt string. A
 * transcription failure writes narrativeStatus 'error' with a message
 * identifying it as a transcription failure, the same way a generation
 * failure does; it never falls back to an empty prompt. The upload itself
 * gets the same pre-multer Content-Length guard (rejectOversizedAudio) that
 * index.js's /capture route uses for Captures, sized for a recording instead
 * of a screenshot, so an oversized body is refused before it is buffered.
 *
 * Every route below that addresses an existing draft (as opposed to creating
 * one) goes through loadOwnedDraft() for its exists/workspace-ownership
 * check, rather than repeating it inline.
 *
 * Finalizing into a PDF (#89)  —  POST /admin/storyboards/:id/finalize
 * requires narrativeStatus === 'done' (edited via #87 or not — both are
 * valid; an edit never changes the status) and is refused otherwise. It
 * assembles a PDF — a narrative page, then one page per *included* Capture
 * in curated order with its note — writes it to GCS, and creates a `reports`
 * Firestore doc with `reportType: 'storyboard'`. ADR 0013 put Storyboard
 * generation's *eventual* artifact in the `reports` collection precisely so
 * it shows up in the existing Reports list (view/download) the same way any
 * other report does — this route is that landing point, so it writes
 * directly to `reports` rather than going through POST /admin/reports/
 * generate's fire-and-forget self-HTTP worker dispatch. That dispatch has no
 * listening server in this test suite (nothing here proves it runs), which
 * is exactly the kind of untested MVP plumbing #86 already declined to
 * build on for narrative generation; assembling the PDF in-process, the way
 * generateNarrative() calls Vertex AI in-process, keeps this route testable
 * the same way.
 *
 * Generate a narrated video (#90)  —  POST /admin/storyboards/:id/video is a
 * separate, explicit action from finalizing — never triggered alongside the
 * PDF, since Shotstack bills per render. It requires a *finalized* PDF to
 * already exist (a `reports` doc with reportType 'storyboard' and
 * status 'done' for this draft), not just a completed narrative — checked by
 * querying `reports` on storyboardDraftId alone (a single-field filter,
 * always indexed) and filtering reportType/status in memory, the same
 * "avoid a composite index this repo hasn't deployed" caution
 * GET /admin/projects/:id/export already documents.
 *
 * The audio track is always synthesized from narrativeText via Vertex AI
 * text-to-speech — never the operator's raw recording from #88, even when
 * one exists; #88's recording was only ever a route to a typed prompt, and
 * playing it back would defeat the point of a narrative someone read over. A
 * Shotstack timeline (ordered image assets, the synthesized audio,
 * transitions) is posted to Shotstack's /render, which theHammer has no
 * queue/worker to be notified from — see lib/shotstack.js's header for how
 * status instead gets refreshed by polling, lazily, from the Reports view
 * that already polls for the PDF.
 *
 * Auth: requireAnalyst, not requireAdmin like exports.js/activity.js — #85's
 * own acceptance criteria call for Analyst-and-above, matching the gate
 * reports.js already uses. It admits Admin too, since `admin` (4) outranks
 * `analyst` (3) in ROLE_HIERARCHY.
 */

'use strict';

const express = require('express');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const { Timestamp } = require('firebase-admin/firestore');
const { Storage } = require('@google-cloud/storage');
const logger = require('../../lib/logger');
const { db } = require('../../lib/firestore');
const { requireAnalyst } = require('../../middleware/requireAuth');
const { getAIClient } = require('../../lib/vertex');
const { submitRender } = require('../../lib/shotstack');
const collections = require('../../lib/collections');
const { loadOwnedProject, belongsToCaller } = require('../../lib/ownership');

const router = express.Router();

const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET || 'thehammer-storage-2026';

// A short spoken walkthrough, not a file transfer — generous for a few
// minutes of audio without inviting an arbitrary media upload.
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

// What MediaRecorder in a browser actually produces (webm/ogg), plus the
// common container formats a client could otherwise send.
const ACCEPTED_AUDIO_TYPES = {
  'audio/webm': 'webm',
  'audio/ogg':  'ogg',
  'audio/wav':  'wav',
  'audio/mp4':  'm4a',
  'audio/mpeg': 'mp3',
};

// A browser's MediaRecorder reports its mimeType with a codecs parameter
// (e.g. `audio/webm;codecs=opus`), which is what multer sees as the part's
// Content-Type. Matching ACCEPTED_AUDIO_TYPES against the bare type — the
// part before ';' — is what makes a real recording (not just a hand-built
// test upload) accepted.
function baseMimeType(mimetype) {
  return (mimetype || '').split(';')[0].trim().toLowerCase();
}

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ACCEPTED_AUDIO_TYPES[baseMimeType(file.mimetype)]) {
      const err = new Error(`Unsupported audio type: expected one of ${Object.keys(ACCEPTED_AUDIO_TYPES).join(', ')}, received ${file.mimetype}`);
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  }
});

// SEC-07-style guard (index.js's rejectOversizedUpload, ahead of /capture's
// multer) sized for a recording instead of a screenshot: refuse an oversized
// body by its declared Content-Length before multer buffers any of it.
const AUDIO_ENVELOPE_ALLOWANCE = 64 * 1024;
const MAX_AUDIO_REQUEST_BYTES = MAX_AUDIO_BYTES + AUDIO_ENVELOPE_ALLOWANCE;
const AUDIO_DRAIN_BUDGET_BYTES = 2 * MAX_AUDIO_REQUEST_BYTES;

function requireAudioMultipart(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (!ct.startsWith('multipart/form-data')) {
    return res.status(400).json({
      error: 'Content-Type must be multipart/form-data',
      received: ct.slice(0, 120) || '(none)'
    });
  }
  next();
}

function rejectOversizedAudio(req, res, next) {
  const declared = Number(req.headers['content-length']);
  if (!Number.isFinite(declared) || declared <= MAX_AUDIO_REQUEST_BYTES) {
    return next();
  }

  let replied = false;
  const reply = () => {
    if (replied || res.headersSent) return;
    replied = true;
    res.status(413).json({
      error: `Payload Too Large: recording exceeds ${MAX_AUDIO_BYTES / (1024 * 1024)}MB limit`,
      declaredBytes: declared
    });
  };

  // Drain rather than destroy immediately — answering while the client is
  // still sending would reset the socket before it sees the 413. The budget
  // caps how much of an attacker-declared size the server actually reads.
  let drained = 0;
  req.on('data', (chunk) => {
    drained += chunk.length;
    if (drained > AUDIO_DRAIN_BUDGET_BYTES) {
      reply();
      req.destroy();
    }
  });
  req.on('end', reply);
  req.on('error', reply);
  req.on('aborted', reply);
}

// Prompts are typed by hand on one draft, not machine-generated — 4000
// characters is generous headroom without inviting a pasted document.
const MAX_PROMPT_LENGTH = 4000;

// A hand-edited narrative is still hand-typed text, just longer — generous
// headroom for a multi-slide narrative without inviting a pasted document.
const MAX_NARRATIVE_LENGTH = 20000;

// Same lifetime as the Activity view's thumbnails (activity.js) — the
// curation screen is the same kind of "look at pictures for a while" UI.
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

// Shotstack fetches every asset once, promptly after /render is called, but
// a render queue can back up — an hour is generous headroom against the
// thumbnail TTL above, which is sized for a person looking at a screen.
const VIDEO_ASSET_SIGNED_URL_TTL_MS = 60 * 60 * 1000;

// gemini-2.5-flash-preview-tts is Vertex AI's text-to-speech model — chosen
// so speech synthesis stays on the same getAIClient() (lib/vertex.js) every
// other AI call in this file already uses, rather than introducing a
// dedicated TTS vendor. The AC leaves the provider unspecified.
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const TTS_VOICE = 'Kore';

// One slide holds the screen this many seconds before the next transition —
// long enough to read a note aloud without the video dragging.
const VIDEO_SLIDE_SECONDS = 4;

function nowISO() { return new Date().toISOString(); }

function isoOf(value) {
  return value instanceof Timestamp ? value.toDate().toISOString() : value;
}

async function makeSignedUrl(gcsPath, ttlMs = SIGNED_URL_TTL_MS) {
  if (!gcsPath) return null;
  try {
    const [url] = await storage.bucket(BUCKET).file(gcsPath).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + ttlMs,
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

/**
 * Loads a draft by id, enforcing existence and workspace ownership — the
 * guard every route below that addresses an existing draft (as opposed to
 * creating one) needs first. Writes the 404/403 response itself and returns
 * null when the draft can't be used; returns `{ ref, snap, existing }` when
 * it can, so the caller never has to repeat the exists/workspace check or
 * re-fetch the document it already has in hand.
 */
async function loadOwnedDraft(req, res) {
  const ref = db.collection(collections.STORYBOARD_DRAFTS).doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).json({ error: 'storyboard draft not found' });
    return null;
  }
  const existing = snap.data();
  // #99: the comparison is lib/ownership.js's, so a draft with no workspaceId
  // is foreign to everyone here too. The 404 above stays — a Storyboard draft
  // is not a Project, and #99's merged answer covers Projects.
  if (!belongsToCaller(snap, req)) {
    res.status(403).json({ error: 'Forbidden: draft belongs to another workspace' });
    return null;
  }
  return { ref, snap, existing };
}

router.post('/projects/:id/storyboards', requireAnalyst, async (req, res, next) => {
  try {
    const projectId = req.params.id;

    if (!await loadOwnedProject(req, res, projectId)) return;

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
    const loaded = await loadOwnedDraft(req, res);
    if (!loaded) return;
    const draft = await enrichWithSignedUrls(serializeDraft(loaded.snap));
    return res.json(draft);
  } catch (err) { next(err); }
});

router.patch('/storyboards/:id', requireAnalyst, async (req, res, next) => {
  try {
    const loaded = await loadOwnedDraft(req, res);
    if (!loaded) return;
    const { ref, existing } = loaded;

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

/** The Project's configured llmModel, shared by narrative generation and
 * audio transcription — both are Gemini calls against the same Project. */
async function getProjectModelId(projectId) {
  const projSnap = await db.collection(collections.PROJECTS).doc(projectId).get();
  return projSnap.data()?.llmModel || 'gemini-1.5-flash';
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
    const modelId = await getProjectModelId(draft.projectId);

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

/**
 * Writes the queued state and fires generation. Shared by the typed-prompt
 * route below and the audio-transcript route further down (#88) — whichever
 * produced the prompt string, triggering generation from it is one code
 * path, not two.
 */
async function queueNarrativeGeneration(ref, draftId, prompt) {
  await ref.update({
    narrativeStatus: 'queued',
    narrativePrompt: prompt,
    narrativeText: null,
    narrativeError: null,
    updatedAt: nowISO(),
  });

  generateNarrative(draftId, prompt).catch((err) => {
    logger.error(`[Storyboard Narrative] unhandled error for draft ${draftId}:`, err);
  });

  const queuedSnap = await ref.get();
  return enrichWithSignedUrls(serializeDraft(queuedSnap));
}

router.post('/storyboards/:id/narrative', requireAnalyst, async (req, res, next) => {
  try {
    const loaded = await loadOwnedDraft(req, res);
    if (!loaded) return;
    const { ref } = loaded;

    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({ error: `prompt must be ${MAX_PROMPT_LENGTH} characters or fewer` });
    }

    return res.status(202).json(await queueNarrativeGeneration(ref, req.params.id, prompt));
  } catch (err) { next(err); }
});

router.patch('/storyboards/:id/narrative', requireAnalyst, async (req, res, next) => {
  try {
    const loaded = await loadOwnedDraft(req, res);
    if (!loaded) return;
    const { ref, existing } = loaded;

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

/**
 * Builds the Gemini transcription request for one recorded audio clip, as a
 * gs:// reference plus an instruction to return the transcript verbatim.
 *
 * Exported for direct testing, same reasoning as buildNarrativeRequest.
 */
function buildTranscriptionRequest(gcsUri, mimeType) {
  return {
    contents: [{
      role: 'user',
      parts: [
        { text: 'Transcribe this audio recording verbatim. Return only the transcript text, with no commentary or formatting.' },
        { fileData: { mimeType, fileUri: gcsUri } },
      ],
    }],
  };
}

router.post(
  '/storyboards/:id/narrative/audio',
  requireAnalyst,
  requireAudioMultipart,
  rejectOversizedAudio,
  (req, res, next) => {
    audioUpload.single('file')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: `Payload Too Large: recording exceeds ${MAX_AUDIO_BYTES / (1024 * 1024)}MB limit` });
        }
        return res.status(400).json({ error: err.message });
      } else if (err) {
        return res.status(err.status === 400 ? 400 : 500).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      const loaded = await loadOwnedDraft(req, res);
      if (!loaded) return;
      const { ref, existing } = loaded;

      if (!req.file) {
        return res.status(400).json({ error: 'Missing required field: file' });
      }

      // One fixed object per draft — a re-recording replaces the last one,
      // there is no need to keep every take.
      const mimeType = baseMimeType(req.file.mimetype);
      const ext = ACCEPTED_AUDIO_TYPES[mimeType];
      const audioPath = `${existing.projectId}/storyboards/${req.params.id}/audio.${ext}`;
      await storage.bucket(BUCKET).file(audioPath).save(req.file.buffer, {
        metadata: { contentType: mimeType },
      });

      const modelId = await getProjectModelId(existing.projectId);

      let transcript;
      try {
        const client = getAIClient();
        const transcriptionRequest = buildTranscriptionRequest(`gs://${BUCKET}/${audioPath}`, mimeType);
        const resp = await client.models.generateContent({ model: modelId, ...transcriptionRequest });
        transcript = (resp.text ?? '').trim();
        if (!transcript) {
          throw new Error('transcription returned no text');
        }
      } catch (err) {
        // Explicit failure, never a silent fall-through to an empty prompt —
        // the same shape generateNarrative uses for a generation failure.
        logger.error(`[Storyboard Narrative] transcription failed for draft ${req.params.id}:`, err);
        await ref.update({
          narrativeStatus: 'error',
          narrativeError: `Transcription failed: ${err.message}`,
          updatedAt: nowISO(),
        });
        const errSnap = await ref.get();
        return res.status(202).json(await enrichWithSignedUrls(serializeDraft(errSnap)));
      }

      // From here the transcript IS the prompt — queueNarrativeGeneration is
      // the exact function the typed-prompt route calls (#88's own scope:
      // no separate downstream logic for audio vs. typed input).
      const prompt = transcript.slice(0, MAX_PROMPT_LENGTH);
      return res.status(202).json(await queueNarrativeGeneration(ref, req.params.id, prompt));
    } catch (err) { next(err); }
  }
);

/**
 * Assembles the Storyboard PDF: a narrative page, then one page per
 * *included* Capture in curated (slide-number) order, each with its note.
 * Excluded Captures are not in the PDF — the same curation the narrative
 * itself was built from (#86).
 *
 * `compress: false` keeps every page's content stream a plain, greppable
 * FlateDecode-free stream — deliberate, not an oversight: it is what lets a
 * test recover the text pdfkit wrote (order, slide labels, notes) without a
 * PDF-parsing dependency, the same way this file already avoids depending on
 * `reportsWorker.js`'s untested plumbing.
 *
 * Exported for direct testing, same reasoning as buildNarrativeRequest.
 */
async function buildStoryboardPdf(draft) {
  const included = [...draft.captures]
    .filter((c) => c.included)
    .sort((a, b) => a.order - b.order);

  const uploadById = {};
  if (included.length > 0) {
    const refs = included.map((c) => db.collection(collections.UPLOADS).doc(c.captureId));
    const snaps = await db.getAll(...refs);
    snaps.forEach((s) => { if (s.exists) uploadById[s.id] = s.data(); });
  }

  const doc = new PDFDocument({ autoFirstPage: false, margin: 50, compress: false });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.addPage();
  doc.fontSize(20).text('Storyboard Narrative');
  doc.moveDown();
  doc.fontSize(12).text(draft.narrativeText || '');

  for (const c of included) {
    doc.addPage();
    doc.fontSize(16).text(`Slide ${c.order}`);
    doc.moveDown(0.5);

    const upload = uploadById[c.captureId];
    const gcsPath = upload?.gcsPath ?? upload?.path ?? null;
    if (gcsPath) {
      const [bytes] = await storage.bucket(BUCKET).file(gcsPath).download();
      doc.image(bytes, { fit: [480, 480] });
      doc.moveDown(0.5);
    }
    if (c.note) {
      doc.fontSize(11).text(c.note);
    }
  }

  doc.end();
  return finished;
}

router.post('/storyboards/:id/finalize', requireAnalyst, async (req, res, next) => {
  try {
    const loaded = await loadOwnedDraft(req, res);
    if (!loaded) return;
    const { existing, snap } = loaded;

    // #87's edit only ever changes narrativeText, never narrativeStatus, so
    // this admits both an edited and an unedited narrative — and refuses a
    // draft that never finished generating one at all.
    if (existing.narrativeStatus !== 'done') {
      return res.status(400).json({ error: 'draft has no completed narrative to finalize' });
    }

    const draft = serializeDraft(snap);

    const reportRef = await db.collection(collections.REPORTS).add({
      projectId: draft.projectId,
      reportType: 'storyboard',
      dateRange: null,
      status: 'processing',
      gcsPath: null,
      storyboardDraftId: draft.id,
      requestedBy: req.hammerUser.id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      schemaVersion: 1,
    });

    try {
      const pdfBuffer = await buildStoryboardPdf(draft);
      const gcsPath = `${draft.projectId}/reports/${reportRef.id}.pdf`;
      await storage.bucket(BUCKET).file(gcsPath).save(pdfBuffer, {
        metadata: { contentType: 'application/pdf' },
      });

      await reportRef.update({ status: 'done', gcsPath, updatedAt: nowISO() });
    } catch (err) {
      logger.error(`[Storyboard Finalize] PDF assembly failed for draft ${req.params.id}:`, err);
      await reportRef.update({ status: 'error', updatedAt: nowISO() });
      return res.status(500).json({ error: 'Failed to assemble Storyboard PDF' });
    }

    const reportSnap = await reportRef.get();
    return res.status(201).json({ id: reportSnap.id, ...reportSnap.data() });
  } catch (err) { next(err); }
});

/**
 * Wraps raw PCM samples in a minimal 44-byte WAV header. Vertex AI's TTS
 * models hand back headerless PCM (their `inlineData.mimeType` names the
 * sample rate, e.g. `audio/L16;rate=24000`) — a WAV container is what makes
 * that playable by anything downstream, Shotstack included.
 */
function pcmToWav(pcmBuffer, sampleRate, channels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Synthesizes narrationText into a WAV buffer via Vertex AI text-to-speech —
 * always the finalized narrative, never #88's raw recording (playing back
 * an operator's own voice would defeat the point of a narrative someone
 * wrote/edited to be read aloud).
 *
 * Exported for direct testing, same reasoning as buildNarrativeRequest.
 */
async function synthesizeNarration(narrationText) {
  const client = getAIClient();
  const resp = await client.models.generateContent({
    model: TTS_MODEL,
    contents: [{ role: 'user', parts: [{ text: narrationText }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } },
    },
  });

  const part = resp?.candidates?.[0]?.content?.parts?.[0];
  const base64Audio = part?.inlineData?.data;
  if (!base64Audio) {
    throw new Error('text-to-speech returned no audio');
  }

  const mimeType = part.inlineData.mimeType || '';
  const sampleRate = Number(/rate=(\d+)/.exec(mimeType)?.[1]) || 24000;
  return pcmToWav(Buffer.from(base64Audio, 'base64'), sampleRate);
}

/**
 * Builds the Shotstack timeline: one image clip per curated Capture URL, in
 * the order given, laid end to end with a fade transition, plus the
 * narration as the timeline's soundtrack. Takes already-resolved asset URLs
 * rather than Captures themselves, so the curated-order guarantee can be
 * tested directly without a GCS or Shotstack double.
 *
 * Exported for direct testing, same reasoning as buildNarrativeRequest.
 */
function buildShotstackTimeline(imageUrls, audioUrl) {
  let start = 0;
  const clips = imageUrls.map((src) => {
    const clip = {
      asset: { type: 'image', src },
      start,
      length: VIDEO_SLIDE_SECONDS,
      fit: 'contain',
      transition: { in: 'fade', out: 'fade' },
    };
    start += VIDEO_SLIDE_SECONDS;
    return clip;
  });

  return {
    timeline: {
      soundtrack: { src: audioUrl, effect: 'fadeOut' },
      tracks: [{ clips }],
    },
    output: { format: 'mp4', resolution: 'sd' },
  };
}

router.post('/storyboards/:id/video', requireAnalyst, async (req, res, next) => {
  try {
    const loaded = await loadOwnedDraft(req, res);
    if (!loaded) return;
    const { existing, snap } = loaded;

    if (existing.narrativeStatus !== 'done') {
      return res.status(400).json({ error: 'draft has no completed narrative' });
    }

    // "From a finalized Storyboard" (#90) means a finalized PDF (#89) must
    // already exist — a completed narrative alone isn't enough. Filtered by
    // storyboardDraftId, a single-field (always-indexed) query, with
    // reportType/status checked in memory rather than adding a composite
    // index this repo hasn't deployed.
    const reportsSnap = await db.collection(collections.REPORTS)
      .where('storyboardDraftId', '==', req.params.id)
      .get();
    const finalizedPdf = reportsSnap.docs
      .map((d) => d.data())
      .find((r) => r.reportType === 'storyboard' && r.status === 'done');
    if (!finalizedPdf) {
      return res.status(400).json({ error: 'Storyboard has not been finalized into a PDF yet' });
    }

    const draft = serializeDraft(snap);
    const included = [...draft.captures].filter((c) => c.included).sort((a, b) => a.order - b.order);

    const reportRef = await db.collection(collections.REPORTS).add({
      projectId: draft.projectId,
      reportType: 'storyboard-video',
      dateRange: null,
      status: 'queued',
      gcsPath: null,
      storyboardDraftId: draft.id,
      shotstackRenderId: null,
      requestedBy: req.hammerUser.id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      schemaVersion: 1,
    });

    try {
      const narrationBuffer = await synthesizeNarration(draft.narrativeText);
      const audioPath = `${draft.projectId}/reports/${reportRef.id}/narration.wav`;
      await storage.bucket(BUCKET).file(audioPath).save(narrationBuffer, {
        metadata: { contentType: 'audio/wav' },
      });
      const audioUrl = await makeSignedUrl(audioPath, VIDEO_ASSET_SIGNED_URL_TTL_MS);

      const uploadRefs = included.map((c) => db.collection(collections.UPLOADS).doc(c.captureId));
      const uploadSnaps = uploadRefs.length > 0 ? await db.getAll(...uploadRefs) : [];
      const uploadById = {};
      uploadSnaps.forEach((s) => { if (s.exists) uploadById[s.id] = s.data(); });
      const imageUrls = await Promise.all(included.map((c) => {
        const upload = uploadById[c.captureId];
        return makeSignedUrl(upload?.gcsPath ?? upload?.path ?? null, VIDEO_ASSET_SIGNED_URL_TTL_MS);
      }));

      const timeline = buildShotstackTimeline(imageUrls, audioUrl);
      const renderId = await submitRender(timeline);

      await reportRef.update({ status: 'processing', shotstackRenderId: renderId, updatedAt: nowISO() });
    } catch (err) {
      logger.error(`[Storyboard Video] generation failed for draft ${req.params.id}:`, err);
      await reportRef.update({ status: 'error', error: err.message, updatedAt: nowISO() });
      return res.status(500).json({ error: 'Failed to start video generation' });
    }

    const reportSnap = await reportRef.get();
    return res.status(201).json({ id: reportSnap.id, ...reportSnap.data() });
  } catch (err) { next(err); }
});

router.buildNarrativeRequest = buildNarrativeRequest;
router.buildTranscriptionRequest = buildTranscriptionRequest;
router.buildStoryboardPdf = buildStoryboardPdf;
router.synthesizeNarration = synthesizeNarration;
router.buildShotstackTimeline = buildShotstackTimeline;
router.generateNarrative = generateNarrative;

module.exports = router;
