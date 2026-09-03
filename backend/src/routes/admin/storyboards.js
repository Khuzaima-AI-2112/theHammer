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
 * AI narrative generation (#86), review/edit (#87), audio input (#88), and
 * finalizing into a PDF (#89) are separate tickets and do not live here.
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
const { db } = require('../../lib/firestore');
const { requireAnalyst } = require('../../middleware/requireAuth');
const collections = require('../../lib/collections');

const router = express.Router();

const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET || 'thehammer-storage-2026';

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

module.exports = router;
