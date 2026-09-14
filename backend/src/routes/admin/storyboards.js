/**
 * Storyboard drafts (#85)  —  curate and persist a Capture selection
 *
 * POST  /admin/projects/:id/storyboards  → find-or-create the Project's
 *                                           open draft
 * GET   /admin/storyboards/:id           → fetch a draft
 * PATCH /admin/storyboards/:id           → update checkboxes/order/notes, and
 *                                           the Workflow dividers (#126)
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
 * assembles a PDF — the synthesis, then the *included* Captures in curated
 * order as a grid of six frames to a page, each with its own caption (#125;
 * until then it was a page per Capture), grouped under the curator's Workflow
 * headings (#126, ADR 0020) — writes it to GCS, and creates a `reports` Firestore doc with
 * `reportType: 'storyboard'`. ADR 0013 put Storyboard
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
const { getStorage } = require('../../lib/storage');
const logger = require('../../lib/logger');
const { db } = require('../../lib/firestore');
const { requireAnalyst } = require('../../middleware/requireAuth');
const { getAIClient } = require('../../lib/vertex');
const {
  DEFAULT_LLM_MODEL, TTS_MODEL, TTS_VOICE, OCR_MAX_PAIRS,
  STORYBOARD_CAPTION_MAX_WORDS, storyboardMaxOutputTokens,
} = require('../../lib/models');
const { submitRender } = require('../../lib/shotstack');
const { renderMarkdown } = require('../../lib/narrativeMarkdown');
const { prefetchInOrder } = require('../../lib/prefetch');
const { mustFinishBy } = require('../../lib/reportDeadline');
const { wavDurationSeconds, apportionNarration } = require('../../lib/narrationTiming');
const collections = require('../../lib/collections');
const { loadOwnedProject, belongsToCaller } = require('../../lib/ownership');
const { validateWorkflows, workflowByCaptureId } = require('../../lib/workflows');

const router = express.Router();

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

// Speech synthesis runs on Vertex's own text-to-speech model, so it stays on
// the same getAIClient() (lib/vertex.js) every other AI call in this file
// already uses, rather than introducing a dedicated TTS vendor. The AC leaves
// the provider unspecified. TTS_MODEL and TTS_VOICE are owned by
// lib/models.js — the previous id here was a Gemini API one that 404s on
// Vertex, so this path had never once succeeded (#108).

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
    const [url] = await getStorage().bucket(BUCKET).file(gcsPath).getSignedUrl({
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
    // #126, ADR 0020: the curator's Workflow dividers, in list order. A draft
    // made before them has none, and reads as an empty list without migration.
    workflows: d.workflows ?? [],
    narrativeStatus: d.narrativeStatus ?? null,
    narrativePrompt: d.narrativePrompt ?? null,
    narrativeText: d.narrativeText ?? null,
    // #124: one caption per included Capture, keyed by captureId so a reorder
    // after generation moves the slide number without moving the words.
    narrativeCaptions: d.narrativeCaptions ?? null,
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

    // The snapshot is kept rather than discarded (#111): it carries the
    // Workspace a new draft is stamped with below, and the ownership check has
    // already read it. Same shape as the two upload paths in src/index.js
    // (#102) — the value is the Project's, never the caller's (lesson 67).
    const projectSnap = await loadOwnedProject(req, res, projectId);
    if (!projectSnap) return;

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
      workspaceId: projectSnap.data().workspaceId,
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

/**
 * The Project's Storyboards, as a list to choose from (#96).
 *
 * Added for the OCR Report picker: an OCR Report is generated for a Storyboard
 * (ADR 0017), and nothing could enumerate them — the portal held exactly one
 * draft in memory, and the only reads were "create or resume" and "fetch by
 * id".
 *
 * Deliberately not `enrichWithSignedUrls`: a picker needs names and sizes, and
 * minting a signed URL per Capture across every Storyboard in a Project would
 * be dozens of pointless round trips. `includedCaptures` is here because it is
 * what decides whether a Report can be generated at all and how much of the
 * workflow it will cover.
 */
router.get('/projects/:id/storyboards', requireAnalyst, async (req, res, next) => {
  try {
    if (!await loadOwnedProject(req, res, req.params.id)) return;

    const snap = await db.collection(collections.STORYBOARD_DRAFTS)
      .where('projectId', '==', req.params.id)
      .get();

    const storyboards = snap.docs.map((d) => {
      const data = d.data();
      const captures = data.captures ?? [];
      return {
        id: d.id,
        status: data.status ?? null,
        createdAt: data.createdAt ?? null,
        totalCaptures: captures.length,
        includedCaptures: captures.filter((c) => c.included).length,
      };
    // Newest first, sorted in memory: the collection has no
    // (projectId, createdAt) composite index deployed, and this is a handful
    // of rows per Project — the same reasoning as the export query above.
    }).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));

    // The cap travels with the list so the portal can state coverage without
    // holding its own copy of the number. ADR 0017 puts this value in
    // lib/models.js and means it: a portal that hardcoded 20 would keep
    // promising "the first 20" after the backend started enforcing something
    // else, which is a wrong statement about what the Report examined.
    return res.json({ storyboards, total: storyboards.length, maxPairs: OCR_MAX_PAIRS });
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

    const update = { captures: nextCaptures, updatedAt: nowISO() };

    // Optional, so a caller that only curates frames cannot wipe the dividers
    // by leaving them out; an empty list is how they are all deleted (#126).
    // Checked against the draft's fixed frame count, which the checks above
    // have just proved this PATCH matches.
    if (req.body.workflows !== undefined) {
      const checked = validateWorkflows(req.body.workflows, nextCaptures.length);
      if (checked.error) return res.status(400).json({ error: checked.error });
      update.workflows = checked.workflows;
    }

    await ref.update(update);

    const updatedSnap = await ref.get();
    const draft = await enrichWithSignedUrls(serializeDraft(updatedSnap));
    return res.json(draft);
  } catch (err) { next(err); }
});

/**
 * What a narrative generation must come back as (#124, ADR 0019).
 *
 * Two outputs from one call: the free-form synthesis the Storyboard opens with,
 * and one caption per slide to be drawn beside its screenshot (#125). The
 * schema is enforced by the API, so the instruction below carries only what a
 * schema cannot say — what a caption is *for*, and how long it may be.
 */
/**
 * The slides of a Storyboard: included only, in the Analyst's chosen order.
 *
 * One definition, because three things have to agree on it exactly — the
 * request sends these slide numbers, the response is validated against them,
 * and the PDF draws them. Two copies of the filter-and-sort would let the set
 * the model was asked about drift from the set its answer is checked against,
 * and the mismatch would read as a model that skipped a slide.
 */
function includedCaptures(draft) {
  return [...(draft.captures ?? [])]
    .filter((c) => c.included)
    .sort((a, b) => a.order - b.order);
}

const NARRATIVE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    synthesis: {
      type: 'STRING',
      description: 'The narrative that opens the Storyboard: what these screens show, taken together. Markdown.',
    },
    captions: {
      type: 'ARRAY',
      description: 'One entry per slide, covering every slide and no others.',
      items: {
        type: 'OBJECT',
        properties: {
          slide: { type: 'INTEGER', description: 'The slide number exactly as stated in the request.' },
          caption: { type: 'STRING', description: 'What this one screenshot shows.' },
        },
        required: ['slide', 'caption'],
      },
    },
  },
  required: ['synthesis', 'captions'],
};

/**
 * The product's only words in this request — and the reason ADR 0016's
 * clearance had to be re-argued rather than assumed (see its #124 amendment).
 *
 * #119's defect was a prompt that asked for a *voice* ("an executive
 * assistant"), and forward-looking filler is what that register is made of.
 * This asks for a *shape*: which slide a caption belongs to, and how much room
 * it has. It says nothing about stance, and the Analyst's own instruction is
 * still parts[0] — it comes first in the request because it is what steers.
 */
const NARRATIVE_FORMAT_INSTRUCTION = [
  'Return a synthesis and one caption per slide.',
  '',
  `Each caption describes that one screenshot in at most ${STORYBOARD_CAPTION_MAX_WORDS} words —`,
  'it is printed underneath the screenshot itself, so it has room for two or three short sentences.',
  'Use the slide numbers exactly as they are stated above: one caption for every slide, and none for a number that was not given.',
  'The synthesis is separate and is not repeated in the captions.',
].join('\n');

/**
 * Builds the multimodal Gemini request from a draft: the prompt, then each
 * *included* Capture in slide order as a gs:// image reference, with its note
 * (if any) as the text part immediately after it. Excluded Captures are not
 * sent — the AI only sees what the Analyst curated.
 *
 * No per-Capture tagging step exists anywhere in this — the AI receives the
 * ordered images and notes and writes what each one shows. What it does *not*
 * decide is where the sections fall: that is the curator's Workflow dividers
 * (ADR 0020, superseding ADR 0019's reading of `stage`). Each slide's Workflow
 * name is sent as context, and the model has no way to answer back about it.
 *
 * Exported so tests can assert on the request shape directly, without a
 * mocked AI client or the timing of an async generation run.
 */
// #119 reviewed this path for the embellishment the Reports narrative had and
// cleared it, on the grounds that the product supplied no prompt of its own.
// #124 added one — NARRATIVE_FORMAT_INSTRUCTION — so that clearance lapsed by
// its own terms and was re-argued rather than assumed: see ADR 0016's #124
// amendment for why a request for a *shape* does not carry #119's defect, and
// why narrativeGuard still must not run over a Storyboard.

async function buildNarrativeRequest(draft, prompt) {
  const included = includedCaptures(draft);

  const parts = [{ text: prompt }, { text: NARRATIVE_FORMAT_INSTRUCTION }];

  if (included.length > 0) {
    const refs = included.map((c) => db.collection(collections.UPLOADS).doc(c.captureId));
    const snaps = await db.getAll(...refs);
    const uploadById = {};
    snaps.forEach((s) => { if (s.exists) uploadById[s.id] = s.data(); });

    // The same lookup the PDF heads its pages from, so the name the model is
    // told is the heading the caption ends up under.
    const workflowOf = workflowByCaptureId(draft.captures, draft.workflows);

    for (const c of included) {
      const upload = uploadById[c.captureId];
      const gcsPath = upload?.gcsPath ?? upload?.path ?? null;
      // The slide number is stated for every slide, not only the ones carrying
      // a note — it is the key a caption comes back under, so an unnumbered
      // image is one the model can only guess the number of.
      parts.push({ text: `Slide ${c.order}:` });
      // Context, not a question (#126, ADR 0020): the curator has already
      // decided where each Workflow starts, and nothing in the response schema
      // gives the model a way to say otherwise.
      const workflow = workflowOf.get(c.captureId);
      if (workflow) {
        parts.push({ text: `Slide ${c.order} workflow: ${workflow.name}` });
      }
      if (gcsPath) {
        parts.push({ fileData: { mimeType: 'image/png', fileUri: `gs://${BUCKET}/${gcsPath}` } });
      }
      if (c.note) {
        parts.push({ text: `Slide ${c.order} note: ${c.note}` });
      }
    }
  }

  return {
    contents: [{ role: 'user', parts }],
    config: {
      // Shared with the model's own reasoning tokens on a thinking model, and
      // sized against the slide count because the answer grows with it — see
      // storyboardMaxOutputTokens in lib/models.js.
      maxOutputTokens: storyboardMaxOutputTokens(included.length),
      responseMimeType: 'application/json',
      responseSchema: NARRATIVE_SCHEMA,
    },
  };
}

/**
 * Turns the model's JSON into the two things the draft stores, or throws.
 *
 * Pure, and exported, for the same reason `parseMarkdown` is split from
 * `renderMarkdown` (ADR 0018): the validation fails in ways that have nothing
 * to do with Vertex being reachable, and each of those ways is a slide that
 * reaches a client with nothing written on it if it goes unnoticed.
 *
 * Captions come back keyed by **slide number** — short, already stated in the
 * request, and not a 120-character URL-encoded document id the model would
 * have to echo exactly 66 times. They are stored keyed by `captureId`, because
 * the Analyst can reorder afterwards and a caption must follow its screenshot,
 * not its position.
 *
 * @param {string} rawText the model's response text
 * @param {{captureId: string, order: number}[]} included the curated slides
 */
function parseNarrativeResponse(rawText, included) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    // The shape of a budget spent entirely on reasoning: a structurally valid,
    // completely empty answer. lib/models.js documents why that happens.
    throw new Error('the model returned no text');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`the model did not return valid JSON: ${err.message}`);
  }

  const synthesis = typeof parsed?.synthesis === 'string' ? parsed.synthesis.trim() : '';
  if (synthesis === '') throw new Error('the model returned no synthesis');

  const captions = Array.isArray(parsed?.captions) ? parsed.captions : null;
  if (!captions) throw new Error('the model returned no captions list');

  const byOrder = new Map(included.map((c) => [c.order, c.captureId]));
  const captionByCaptureId = new Map();

  for (const entry of captions) {
    const slide = entry?.slide;
    const captureId = byOrder.get(slide);
    if (!captureId) {
      throw new Error(`the model returned a caption for slide ${slide}, which is not in this Storyboard`);
    }
    if (captionByCaptureId.has(captureId)) {
      throw new Error(`the model returned a duplicate caption for slide ${slide}`);
    }
    const caption = typeof entry?.caption === 'string' ? entry.caption.trim() : '';
    if (caption === '') throw new Error(`the model returned an empty caption for slide ${slide}`);
    captionByCaptureId.set(captureId, caption);
  }

  // Checked last, and against the curated set rather than the response, so the
  // error names the slide that would have been blank.
  const missing = included.find((c) => !captionByCaptureId.has(c.captureId));
  if (missing) {
    throw new Error(`the model returned no caption for slide ${missing.order}`);
  }

  return {
    synthesis,
    captions: included.map((c) => ({ captureId: c.captureId, caption: captionByCaptureId.get(c.captureId) })),
  };
}

/** The Project's configured llmModel, shared by narrative generation and
 * audio transcription — both are Gemini calls against the same Project. */
async function getProjectModelId(projectId) {
  const projSnap = await db.collection(collections.PROJECTS).doc(projectId).get();
  return projSnap.data()?.llmModel || DEFAULT_LLM_MODEL;
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

    const included = includedCaptures(draft);
    // Throws into the catch below on anything malformed, so a Storyboard with
    // a slide the model skipped never reaches 'done' — a caption missing here
    // is a blank space on a page someone hands to a client (#124).
    const { synthesis, captions } = parseNarrativeResponse(resp.text, included);

    await ref.update({
      narrativeStatus: 'done',
      // Still the free-form half, still Markdown, still the field #87 edits and
      // #89 renders — the captions are new state beside it, not a replacement.
      narrativeText: synthesis,
      narrativeCaptions: captions,
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
 * An Analyst corrects one Caption by hand (#129). Its own route rather than a
 * field on the draft PATCH, because generation writes `narrativeCaptions` too:
 * a page saving the whole draft from a stale copy would overwrite a
 * regeneration that finished in the background. The edited mark is what lets
 * the portal warn before a regeneration replaces it.
 */
router.patch('/storyboards/:id/captions', requireAnalyst, async (req, res, next) => {
  try {
    const loaded = await loadOwnedDraft(req, res);
    if (!loaded) return;
    const { ref } = loaded;

    const { captureId } = req.body ?? {};
    // Trimmed as parseNarrativeResponse trims the model's. A blank Caption is
    // refused rather than stored: it drops out of the narration but still holds
    // the screen, so every slide after it plays late (ADR 0019, #128).
    const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim() : '';
    if (caption === '') {
      return res.status(400).json({ error: 'caption must be a non-blank string' });
    }
    // The budget the model is asked to keep is enforced on a hand edit: the PDF
    // cell and the video's slide timing were both sized for it.
    if (caption.split(/\s+/).length > STORYBOARD_CAPTION_MAX_WORDS) {
      return res.status(400).json({ error: `caption must be ${STORYBOARD_CAPTION_MAX_WORDS} words or fewer` });
    }

    const editedCaption = { captureId, caption, edited: true };

    // Read and written in one transaction: a regeneration that settles between
    // a plain read and write would have its fresh Captions put back to the old.
    await db.runTransaction(async (tx) => {
      const draft = (await tx.get(ref)).data();

      // Queued or generating, the Captions are about to be replaced. Errored,
      // they are the previous run's leftovers: queueing blanks the synthesis,
      // not them.
      if (draft.narrativeStatus !== 'done') {
        throw Object.assign(
          new Error('captions can only be edited once the narrative has finished generating'), { status: 400 });
      }
      // Any slide in the draft, not only the included ones: ticking a slide is
      // curation the page may not have saved yet. The portal hides the box on a
      // slide it shows as excluded.
      if (!(draft.captures ?? []).some((c) => c.captureId === captureId)) {
        throw Object.assign(new Error('captureId must be a slide in this Storyboard'), { status: 400 });
      }

      // Every reader looks a Caption up by captureId, so one written for a slide
      // the model never saw is appended rather than placed.
      const current = draft.narrativeCaptions ?? [];
      const narrativeCaptions = current.some((c) => c.captureId === captureId)
        ? current.map((c) => (c.captureId === captureId ? editedCaption : c))
        : [...current, editedCaption];
      tx.update(ref, { narrativeCaptions, updatedAt: nowISO() });
    });

    const updatedSnap = await ref.get();
    return res.json(await enrichWithSignedUrls(serializeDraft(updatedSnap)));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
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
      await getStorage().bucket(BUCKET).file(audioPath).save(req.file.buffer, {
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
 * The Storyboard grid (#125, ADR 0019).
 *
 * Six frames to a page, two across and three down, which is the layout the
 * one hand-built Storyboard that exists uses. The alternative — the page per
 * Capture this file drew until #125 — turned the real 66-Capture draft into
 * 73 pages, 66 of them a heading, a screenshot and nothing else.
 */
const FRAME_COLUMNS = 2;
const FRAME_ROWS = 3;
const FRAMES_PER_PAGE = FRAME_COLUMNS * FRAME_ROWS;
const FRAME_GUTTER = 18;   // between columns
const FRAME_ROW_GAP = 14;  // between rows

// A cell's bands, top to bottom. The label and the image are fixed so that
// every frame on a page lines up; the caption is capped, not fixed, and the
// note takes whatever the caption left plus whatever the cell has spare. A
// caption that hits its cap is what #124's 45-word budget exists to prevent —
// at 8.5pt in a 247pt cell, 45 words comes to about five lines of the six the
// cap allows.
const FRAME_LABEL_HEIGHT = 12;
const FRAME_IMAGE_HEIGHT = 112;
const FRAME_CAPTION_MAX_HEIGHT = 56;
const FRAME_BAND_GAP = 4;

// Kept on every grid page, headed or not, so an untitled page's frames sit
// exactly where a headed page's do.
const SECTION_HEADER_HEIGHT = 30;

/**
 * How many Capture images assembly keeps in the air at once (#122).
 *
 * Drawing a frame is instant; fetching its image is a round trip to Cloud
 * Storage, and doing 66 of those one after another cost 89.7s from a
 * developer machine — 5.2s in Cloud Run, which shares a region with the
 * bucket (ADR 0013's 2026-09-11 amendment has both numbers and why they
 * differ by so much).
 *
 * Eight is the number #122 proposed, and it is chosen for the second bound as
 * much as the first: this is also the most images held in memory at one time,
 * in a container with 512Mi and a growing uncompressed PDF buffer beside it.
 * Raising it buys progressively less — the first few overlaps remove most of
 * the waiting — and costs memory linearly.
 */
const IMAGE_PREFETCH_AHEAD = 8;

/**
 * What a frame is labelled with: its slide number and where the screenshot was
 * taken — `3 · /admin/retailers`, not `Slide 3`.
 *
 * The path is the part that identifies a screen to somebody reading the
 * document; the host repeats on every frame of a walk and the query string is
 * usually a session id. A root URL has no path worth printing, so it falls
 * back to the host, and anything that is not a URL at all is printed as it was
 * stored rather than dropped — a Capture whose `tabUrl` is odd is worth seeing.
 */
function frameLabel(order, tabUrl) {
  const raw = (tabUrl ?? '').trim();
  let where;
  if (!raw) {
    where = '(no URL)';
  } else {
    try {
      const url = new URL(raw);
      where = url.pathname && url.pathname !== '/' ? url.pathname : url.host;
    } catch (_) {
      where = raw;
    }
  }
  return `${order} · ${where}`;
}

/**
 * The heading over a Workflow's frames (#126, ADR 0020): `Workflow 2 · Brand`.
 *
 * Frames above the first divider have no Workflow and get no heading at all —
 * null, not a placeholder. ADR 0019 printed `Unassigned Persona` in that case,
 * read from the Capture's `stage`, which turned out never to hold a Persona.
 */
function workflowHeading(workflow) {
  return workflow ? `Workflow ${workflow.number} · ${workflow.name}` : null;
}

/**
 * Lays a page's frames out: where cell `slot` starts, and how big it is.
 *
 * Returned by value rather than assigned into the drawing loop's scope so the
 * arithmetic lives in one place and a caller cannot read a cell position that
 * belongs to the previous page. The page's own margins and size are what it is
 * measured from; only the bands *inside* a cell are fixed constants.
 */
function frameGridFor(doc) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const top = doc.page.margins.top + SECTION_HEADER_HEIGHT;
  const cellWidth = (width - FRAME_GUTTER * (FRAME_COLUMNS - 1)) / FRAME_COLUMNS;
  const cellHeight =
    (doc.page.height - doc.page.margins.bottom - top - FRAME_ROW_GAP * (FRAME_ROWS - 1)) / FRAME_ROWS;

  return {
    width,
    cellWidth,
    cellHeight,
    cellAt(slot) {
      return {
        x: left + (slot % FRAME_COLUMNS) * (cellWidth + FRAME_GUTTER),
        y: top + Math.floor(slot / FRAME_COLUMNS) * (cellHeight + FRAME_ROW_GAP),
      };
    },
  };
}

/**
 * The caption written about each slide, by Capture id (#124, ADR 0019).
 *
 * One definition for the same reason `includedCaptures` is one: the PDF draws
 * these and the video speaks them, and a draft generated before #124 carries
 * none at all.
 */
function captionsByCaptureId(draft) {
  return new Map((draft.narrativeCaptions ?? []).map((c) => [c.captureId, c.caption]));
}

/**
 * Assembles the Storyboard PDF: the synthesis, then the *included* Captures in
 * curated order as a grid of six frames to a page, each Workflow the curator
 * marked starting its own page under a heading (#126, ADR 0020). Excluded
 * Captures are not in the PDF — the same curation the narrative itself was
 * built from (#86). The Capture's `stage` is not read.
 *
 * Each frame carries its slide number, a label derived from the Capture's
 * `tabUrl`, the caption #124 generated for it, and the Analyst's note if there
 * is one. The two empty cases are decided rather than accidental:
 *
 * - **No note.** Nothing is drawn. 0 of 66 Captures in the real draft carry
 *   one, so a `(no note)` placeholder would be the thing the page was mostly
 *   made of.
 * - **No caption.** `(no caption)` is drawn. #124 will not let a generation
 *   reach `done` without one per slide, so a missing caption means a draft
 *   written before #124 or a relaxed rule — either way the gap belongs on the
 *   page, the same instinct as ADR 0018's malformed marker.
 *
 * A Workflow with no included Captures does not appear at all (ADR 0020); the
 * builder shows it as empty instead. The hand-built document made the opposite
 * choice (a `NO CAPTURE EXISTS` page).
 *
 * A caption longer than its cap is ellipsised, not clipped silently: ADR 0019
 * makes density a constraint on the prose and says the overflow has to be
 * visible. #124's 45-word budget is what keeps it from happening — it comes to
 * about five of the six lines the cap allows. A short caption hands the space
 * it did not use to the note below it, which is the one band holding text
 * nothing budgets: the Analyst typed it.
 *
 * `compress: false` keeps every page's content stream a plain, greppable
 * FlateDecode-free stream — deliberate, not an oversight: it is what lets a
 * test recover the text pdfkit wrote (order, frame labels, captions, notes)
 * without a PDF-parsing dependency, the same way this file already avoids
 * depending on `reportsWorker.js`'s untested plumbing.
 *
 * Exported for direct testing, same reasoning as buildNarrativeRequest.
 */
async function buildStoryboardPdf(draft) {
  const included = includedCaptures(draft);

  // Which Workflow each frame prints under. Every included frame has an entry
  // (null above the first divider), so the frames can still be prefetched as
  // one run below.
  const workflowOf = workflowByCaptureId(draft.captures, draft.workflows);

  const uploadById = {};
  if (included.length > 0) {
    const refs = included.map((c) => db.collection(collections.UPLOADS).doc(c.captureId));
    const snaps = await db.getAll(...refs);
    snaps.forEach((s) => { if (s.exists) uploadById[s.id] = s.data(); });
  }

  const captionByCaptureId = captionsByCaptureId(draft);

  const doc = new PDFDocument({ autoFirstPage: false, margin: 50, compress: false });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(20).text('Storyboard Narrative');
  doc.moveDown();
  // Rendered, not printed: the model returns Markdown and `.text()` would
  // draw the `#` and `**` characters onto a client-facing page (#121).
  renderMarkdown(doc, draft.narrativeText || '');

  let grid = null;
  let slot = FRAMES_PER_PAGE;
  // undefined, not null: null is a real value here (the untitled frames above
  // the first divider), and the first frame must always start a page.
  let currentWorkflow;

  function startGridPage(heading) {
    doc.addPage();
    grid = frameGridFor(doc);
    if (heading) {
      doc.font('Helvetica-Bold').fontSize(14).fillColor('black')
        .text(heading, doc.page.margins.left, doc.page.margins.top, {
          width: grid.width, height: SECTION_HEADER_HEIGHT, ellipsis: true,
        });
    }
    slot = 0;
  }

  // The image work is the slow half and the only half that waits on anything,
  // so it runs ahead of the drawing rather than inside it (#122). Order is
  // preserved by prefetchInOrder — the frames are drawn in curated order
  // whatever order Cloud Storage answers in.
  const fetchFrameImage = async (c) => {
    const upload = uploadById[c.captureId];
    const gcsPath = upload?.gcsPath ?? upload?.path ?? null;
    // An Abandoned Upload has a row and no object. Nothing to fetch, and the
    // frame is drawn labelled but empty, exactly as before.
    if (!gcsPath) return null;
    const [bytes] = await getStorage().bucket(BUCKET).file(gcsPath).download();
    return bytes;
  };

  const frames = prefetchInOrder(included, fetchFrameImage, { ahead: IMAGE_PREFETCH_AHEAD });

  for await (const { item: c, value: imageBytes } of frames) {
    const upload = uploadById[c.captureId];
    const workflow = workflowOf.get(c.captureId);
    const heading = workflowHeading(workflow);

    // A new Workflow starts its own page: a header band dropped between two
    // rows of an already-started grid reads as a caption, not as a division.
    // A Workflow that outgrows one page keeps its heading, marked as a
    // continuation, so no page of its frames is unattributed. Untitled frames
    // stay untitled on every page they fill.
    if (workflow !== currentWorkflow) {
      startGridPage(heading);
      currentWorkflow = workflow;
    } else if (slot >= FRAMES_PER_PAGE) {
      startGridPage(heading && `${heading} (continued)`);
    }

    const { x, y } = grid.cellAt(slot);
    slot += 1;

    doc.font('Helvetica-Bold').fontSize(9).fillColor('black')
      .text(frameLabel(c.order, upload?.tabUrl), x, y, {
        width: grid.cellWidth, height: FRAME_LABEL_HEIGHT, lineBreak: false, ellipsis: true,
      });

    if (imageBytes) {
      doc.image(imageBytes, x, y + FRAME_LABEL_HEIGHT, { fit: [grid.cellWidth, FRAME_IMAGE_HEIGHT] });
    }

    const captionY = y + FRAME_LABEL_HEIGHT + FRAME_IMAGE_HEIGHT + FRAME_BAND_GAP;
    const caption = (captionByCaptureId.get(c.captureId) ?? '').trim();
    doc.font('Helvetica').fontSize(8.5).fillColor(caption ? 'black' : '#888888');
    const captionHeight = Math.min(
      doc.heightOfString(caption || '(no caption)', { width: grid.cellWidth }),
      FRAME_CAPTION_MAX_HEIGHT
    );
    doc.text(caption || '(no caption)', x, captionY, {
      width: grid.cellWidth, height: FRAME_CAPTION_MAX_HEIGHT, ellipsis: true,
    });

    if (c.note) {
      // Measured off where the caption actually ended, not off its cap: a
      // typical caption leaves the note two or three more lines than a fixed
      // band would, and the note is the one thing on this page a person wrote
      // by hand.
      const noteY = captionY + captionHeight + FRAME_BAND_GAP;
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#444444')
        .text(`Note: ${c.note}`, x, noteY, {
          width: grid.cellWidth,
          height: Math.max(0, y + grid.cellHeight - noteY),
          ellipsis: true,
        });
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
      // #103, ADR 0014 — the second of this collection's three writers. Taken
      // from the draft rather than by re-reading the Project: loadOwnedDraft has
      // already proved this draft is the caller's, and a draft has carried
      // workspaceId since #88, so the value is in hand.
      workspaceId: existing.workspaceId,
      reportType: 'storyboard',
      dateRange: null,
      status: 'processing',
      gcsPath: null,
      storyboardDraftId: draft.id,
      // Assembly happens below, inside this request, so this request's own
      // death is the row's deadline (#127). Cloud Run kills an overrunning
      // request without running the `catch`, and a `processing` row nothing is
      // working on reads exactly like one about to succeed.
      mustFinishBy: mustFinishBy(),
      requestedBy: req.hammerUser.id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      schemaVersion: 1,
    });

    try {
      const pdfBuffer = await buildStoryboardPdf(draft);
      const gcsPath = `${draft.projectId}/reports/${reportRef.id}.pdf`;
      await getStorage().bucket(BUCKET).file(gcsPath).save(pdfBuffer, {
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
 * What the video says out loud (#124).
 *
 * This used to be `narrativeText` alone, which was then the *whole* narrative.
 * Since #124 `narrativeText` is only the synthesis and the words about each
 * screen live in `narrativeCaptions` (ADR 0019), so narrating it alone would
 * have quietly dropped everything said about the individual slides — a video
 * that got shorter with nothing to show for it, which is the exact class of
 * silent shortening this feature keeps producing.
 *
 * The synthesis opens, then each slide's caption in curated order — the order
 * the images appear in on the timeline, so the words track the picture.
 *
 * A draft generated before #124 carries no captions and narrates exactly as it
 * did before.
 *
 * Exported for direct testing, same reasoning as buildNarrativeRequest.
 */
function buildNarrationText(draft) {
  const captionByCaptureId = captionsByCaptureId(draft);
  const spoken = [
    draft.narrativeText ?? '',
    ...includedCaptures(draft).map((c) => captionByCaptureId.get(c.captureId) ?? ''),
  ];
  return spoken.filter((s) => typeof s === 'string' && s.trim() !== '').join('\n\n');
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
 * `timing` is what `apportionNarration` worked out from the synthesized audio
 * (lib/narrationTiming.js): how long each slide should hold the screen, so the
 * slides last as long as the words about them (#128). Omitted — or null,
 * when the audio's duration could not be read — every slide falls back to
 * VIDEO_SLIDE_SECONDS, which is what produced 4.4 minutes of slides under
 * 8.2 minutes of speech on the real draft.
 *
 * Exported for direct testing, same reasoning as buildNarrativeRequest.
 */
function buildShotstackTimeline(imageUrls, audioUrl, timing = null) {
  // Either the timing covers every slide or it is not used at all. Falling
  // back slide by slide would mix apportioned lengths with the fixed four
  // seconds in one timeline, which is worse than either on its own and would
  // look like a rendering bug rather than a missing measurement.
  const paced = Array.isArray(timing?.slideSeconds)
    && timing.slideSeconds.length === imageUrls.length
    && timing.slideSeconds.every((s) => Number.isFinite(s) && s > 0);

  // The synthesis is about the whole run, so no one slide belongs to it
  // (ADR 0019). It plays over the first slide, before that slide's own words
  // begin — the alternative, a title card, is an asset this feature does not
  // have and #128 did not ask for.
  const leadIn = paced ? (timing.leadInSeconds ?? 0) : 0;

  // Rounded up, not to nearest. Shotstack takes two decimals, and rounding 66
  // clips to nearest can land the timeline a fraction *under* its soundtrack —
  // which is this ticket's own defect, in miniature. Up costs at most 0.01s of
  // silence per slide and cannot truncate.
  const lengthOf = (i) => {
    const seconds = paced ? timing.slideSeconds[i] : VIDEO_SLIDE_SECONDS;
    return Math.ceil((seconds + (i === 0 ? leadIn : 0)) * 100) / 100;
  };

  let start = 0;
  const clips = imageUrls.map((src, i) => {
    const length = lengthOf(i);
    const clip = {
      asset: { type: 'image', src },
      start: Math.round(start * 100) / 100,
      length,
      fit: 'contain',
      transition: { in: 'fade', out: 'fade' },
    };
    start += length;
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
    const included = includedCaptures(draft);

    const reportRef = await db.collection(collections.REPORTS).add({
      projectId: draft.projectId,
      // #103, ADR 0014 — the third writer, same source as finalize's above.
      workspaceId: existing.workspaceId,
      reportType: 'storyboard-video',
      dateRange: null,
      status: 'queued',
      gcsPath: null,
      storyboardDraftId: draft.id,
      shotstackRenderId: null,
      // Synthesis, upload and submit all happen below, inside this request —
      // ~200s of the 300s it is allowed (#127). If it is killed, nothing here
      // gets to write `error`, so the row says when to stop believing it.
      mustFinishBy: mustFinishBy(),
      requestedBy: req.hammerUser.id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      schemaVersion: 1,
    });

    try {
      const narrationBuffer = await synthesizeNarration(buildNarrationText(draft));
      const audioPath = `${draft.projectId}/reports/${reportRef.id}/narration.wav`;
      await getStorage().bucket(BUCKET).file(audioPath).save(narrationBuffer, {
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

      // How long each slide holds, taken from the audio that was actually
      // synthesized rather than from a constant (#128). The captions handed in
      // are the same strings, in the same order, that buildNarrationText just
      // spoke — anything else apportions a recording nobody made.
      const captionByCaptureId = captionsByCaptureId(draft);
      const timing = apportionNarration({
        synthesis: draft.narrativeText ?? '',
        captions: included.map((c) => captionByCaptureId.get(c.captureId) ?? ''),
        audioSeconds: wavDurationSeconds(narrationBuffer),
      });

      const timeline = buildShotstackTimeline(imageUrls, audioUrl, timing);
      const renderId = await submitRender(timeline);

      // The work has left the request: from here the render lives on
      // Shotstack, where minutes are normal, and its liveness is
      // refreshVideoReportStatus's to judge. Clearing the deadline is what
      // stops this row being settled as overdue while it is legitimately
      // rendering (#127).
      await reportRef.update({
        status: 'processing',
        shotstackRenderId: renderId,
        mustFinishBy: null,
        updatedAt: nowISO(),
      });
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
router.parseNarrativeResponse = parseNarrativeResponse;
router.buildTranscriptionRequest = buildTranscriptionRequest;
router.buildStoryboardPdf = buildStoryboardPdf;
router.synthesizeNarration = synthesizeNarration;
router.buildNarrationText = buildNarrationText;
router.buildShotstackTimeline = buildShotstackTimeline;
router.generateNarrative = generateNarrative;
// Exported so the suite asserts against the bound assembly actually uses,
// rather than against a second copy of the number (#122).
router.IMAGE_PREFETCH_AHEAD = IMAGE_PREFETCH_AHEAD;
// Exported for the same reason: the fallback a timeline takes when the audio
// could not be measured is asserted against the constant it actually uses,
// not against a second copy of the number (#128).
router.VIDEO_SLIDE_SECONDS = VIDEO_SLIDE_SECONDS;

module.exports = router;
