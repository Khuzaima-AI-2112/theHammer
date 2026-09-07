'use strict';

/**
 * The Purge — deleting a Project removes everything filed under it (ADR 0015).
 *
 * Deleting a Project used to remove the Project document and its memberships
 * and nothing else. Every read path resolves a Capture through its Project, so
 * what stayed behind could not be listed, exported or reported on by anyone:
 * on 2026-09-07 production held 17 such records and 26 such objects, left by
 * five Projects deleted in June and August (#109).
 *
 * **Ordering is the correctness property, not an optimisation.** Children
 * first, the Project document last. While the Project document survives its
 * children remain addressable, so a Purge that dies halfway is a Purge you run
 * again — which is why this module deletes children and objects and leaves the
 * Project document to its caller. The old route deleted the Project document in
 * the same final batch as the memberships; carrying that shape into a cascade
 * is how #109 happens a second time, permanently.
 *
 * No transaction spans collections and storage, and none is attempted. The
 * ordering rule is what makes partial failure recoverable instead.
 */

const collections = require('./collections');

/**
 * Every collection that carries a `projectId`.
 *
 * `inactivity_events` is the one to watch: it carries a `projectId` but is only
 * ever queried by `sessionId`, so a cascade written from the read paths alone
 * misses it. It is in this list for that reason and no other.
 *
 * A seventh collection given a `projectId` is a line here.
 */
const PURGED_COLLECTIONS = Object.freeze([
  collections.UPLOADS,
  collections.REPORTS,
  collections.SESSION_EVENTS,
  collections.INACTIVITY_EVENTS,
  collections.STORYBOARD_DRAFTS,
  collections.MEMBERSHIPS,
]);

/**
 * Firestore commits at most 500 operations; stay under it, as the old route did.
 * Exported because the sweep in scripts/purge-unreachable.js batches against the
 * same limit — one ceiling, one number.
 */
const BATCH_SIZE = 450;

/** Every object a Project owns lives under this one prefix. */
function prefixFor(projectId) {
  return `${projectId}/`;
}

/** Deletes every row in one collection naming this Project. Returns the count. */
async function deleteByProject(db, name, projectId) {
  const snap = await db.collection(name).where('projectId', '==', projectId).get();
  const docs = snap.docs;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const doc of docs.slice(i, i + BATCH_SIZE)) batch.delete(doc.ref);
    await batch.commit();
  }

  return docs.length;
}

/**
 * Deletes every object under the Project's prefix. Returns how many there were.
 *
 * Images, the JSON sidecar written beside each one, and Report videos all live
 * under `{projectId}/`, which is what makes the storage half complete rather
 * than best-effort: one prefix delete cannot miss an image.
 *
 * A prefix matching nothing is not an error. An Abandoned Upload is a record
 * whose image never arrived — the upload route writes the row before the
 * extension sends the bytes — and Purging one must succeed.
 */
async function deleteObjects(bucket, projectId) {
  const prefix = prefixFor(projectId);
  const [files] = await bucket.getFiles({ prefix });
  if (files.length > 0) await bucket.deleteFiles({ prefix, force: true });
  return files.length;
}

/**
 * Everything filed under a Project, removed — but not the Project document.
 *
 * The caller deletes that, last, once this has returned. Splitting it here is
 * the ordering rule expressed in the shape of the code: there is no way to call
 * this and delete the Project document first.
 *
 * Returns the counts, which the Purge record carries (#115) and which are the
 * only knowledge of the Project's size that outlives it.
 */
async function purgeProjectContents({ db, bucket, projectId }) {
  const records = {};

  for (const name of PURGED_COLLECTIONS) {
    records[name] = await deleteByProject(db, name, projectId);
  }

  // Objects last, but the order is free here: the prefix is derived from the
  // Project id, so no record has to survive for the images to stay findable.
  // The sweep in scripts/purge-unreachable.js is the opposite case — there the
  // records are the only thing that names the prefix, so they go afterwards.
  const objects = await deleteObjects(bucket, projectId);

  return { records, objects };
}

/**
 * Records what a Purge removed (#115).
 *
 * Written before the Project document is deleted, while the facts are still
 * available — after a Purge there is nothing left to inspect, which is the
 * point of it, so this is the only trace. The five Projects behind #109 were
 * identified only by their absence, noticed three weeks later during unrelated
 * work.
 *
 * **The Workspace comes from the Project, never from the caller.** An absent
 * value means the record belongs to nobody, never to whoever asked (lesson 67,
 * ADR 0014) — the rule #102 and #103 established and the one #111 breaks. The
 * Project is already loaded for the ownership check, so it costs no read.
 */
async function recordPurge({ db, projectSnap, actorId, counts }) {
  const project = projectSnap.data();

  await db.collection(collections.PURGES).add({
    projectId:     projectSnap.id,
    projectName:   project.name ?? null,
    workspaceId:   project.workspaceId ?? null,
    purgedBy:      actorId ?? null,
    purgedAt:      new Date().toISOString(),
    counts:        counts.records,
    objectsRemoved: counts.objects,
    schemaVersion: 1,
  });
}

module.exports = {
  PURGED_COLLECTIONS,
  BATCH_SIZE,
  purgeProjectContents,
  recordPurge,
  prefixFor,
};
