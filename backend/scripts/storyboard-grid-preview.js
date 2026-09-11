#!/usr/bin/env node
/**
 * Render a Storyboard draft's PDF to a local file, without finalizing (#125).
 *
 * `buildStoryboardPdf(draft)` is exported on the router and returns the buffer
 * without touching GCS or creating a `reports` doc, so the grid can be looked
 * at before it is a client deliverable. Every defect this feature has had was
 * found by opening the artifact, and none by a green suite — #121's Markdown
 * syntax, #124's one block of prose, #125's 73 pages. This is the thing that
 * opens it.
 *
 * Read-only: it downloads the Captures it draws and writes one local file.
 *
 *   cd backend
 *   GOOGLE_APPLICATION_CREDENTIALS=... GCS_BUCKET=thehammer-storage-2026 \
 *     node scripts/storyboard-grid-preview.js [draftId] [--out grid.pdf]
 *
 * With no draft id it picks the draft with the most included Captures, which
 * is what "the real draft" has meant in #122/#123/#125.
 */
'use strict';

const fs = require('fs');
const { db } = require('../src/lib/firestore');
const collections = require('../src/lib/collections');
const storyboards = require('../src/routes/admin/storyboards');
// The suite's own page counter, rather than a second copy of the same regex —
// both this and storyboard-finalize.test.js are asking the artifact the one
// question #125 is about.
const { countPdfPages } = require('../tests/helpers/pdfText');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

/**
 * Just the fields `buildStoryboardPdf` reads. The router's own `serializeDraft`
 * is not exported and carries the portal's fields too, none of which are drawn.
 */
function serialize(snap) {
  const d = snap.data();
  return {
    id: snap.id,
    projectId: d.projectId,
    status: d.status,
    captures: [...(d.captures ?? [])].sort((a, b) => a.order - b.order),
    narrativeStatus: d.narrativeStatus ?? null,
    narrativeText: d.narrativeText ?? null,
    narrativeCaptions: d.narrativeCaptions ?? null,
  };
}

async function pickDraft(explicitId) {
  if (explicitId) {
    const snap = await db.collection(collections.STORYBOARD_DRAFTS).doc(explicitId).get();
    if (!snap.exists) throw new Error(`no such draft: ${explicitId}`);
    return serialize(snap);
  }
  const all = await db.collection(collections.STORYBOARD_DRAFTS).get();
  if (all.empty) throw new Error('no Storyboard drafts exist');
  const drafts = all.docs.map(serialize);
  drafts.sort((a, b) =>
    b.captures.filter((c) => c.included).length - a.captures.filter((c) => c.included).length);
  return drafts[0];
}

(async () => {
  const draft = await pickDraft(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null);
  const out = arg('--out', 'storyboard-grid.pdf');
  const included = draft.captures.filter((c) => c.included);

  console.log(`draft ${draft.id} — project ${draft.projectId}`);
  console.log(`  captures: ${included.length} included of ${draft.captures.length}`);
  console.log(`  narrativeStatus: ${draft.narrativeStatus}`);
  console.log(`  captions: ${(draft.narrativeCaptions ?? []).length}`);
  console.log(`  notes: ${included.filter((c) => c.note).length}`);

  const started = Date.now();
  const buffer = await storyboards.buildStoryboardPdf(draft);
  const elapsed = Date.now() - started;

  fs.writeFileSync(out, buffer);
  console.log(`\nwrote ${out} — ${countPdfPages(buffer)} pages, ${(buffer.length / 1e6).toFixed(1)}MB, ${(elapsed / 1000).toFixed(1)}s`);
  // firebase-admin keeps its gRPC channel open, so the process does not exit
  // on its own once the work is done.
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
