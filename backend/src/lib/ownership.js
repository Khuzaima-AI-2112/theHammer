'use strict';

/**
 * Workspace ownership — the one place the tenancy check lives (#99).
 *
 * A Workspace is one Customer's isolated tenant, and every route that takes a
 * record id from the request has to prove the record it found is the caller's
 * before answering with it. `requireAdmin` proves the caller is an Admin, not
 * that they are an Admin *here*.
 *
 * Before this file the check was written at each call site as somebody noticed
 * it — seven route families, five spellings, and `denyForeignProject` existing
 * twice as two independent copies. #7 found four routes that had simply never
 * been given one. Lesson 67 is the record of that: a tenancy check is a
 * property of a route family, not of a route.
 *
 * **One answer for unreachable.** A Project that does not exist and a Project
 * belonging to another Customer are refused identically. The Admin routes used
 * to split them — 404 for gone, 403 for foreign — which let an outsider sort
 * real Project ids from imaginary ones by reading the status code. The four
 * extension routes already merged them; this is the merged answer everywhere.
 * The cost is that an Admin who mistypes an id inside their own Workspace is
 * told 403 rather than 404, which is worse diagnostics for a case nobody
 * optimises for: an opaque Firestore id typed by hand.
 *
 * **Absent means nobody.** A record carrying no `workspaceId` is foreign to
 * everyone, never "belongs to whoever asked" (lesson 67). The permissive
 * reading turns every unstamped legacy row into a shared one.
 */

const { db } = require('./firestore');
const collections = require('./collections');

/** The single refusal. Both `status` and `error` are the answer everywhere. */
const UNREACHABLE_PROJECT = Object.freeze({
  status: 403,
  error: 'Forbidden: Project not found or belongs to another workspace',
});

/** The same, for a Monitored User addressed by id. */
const FOREIGN_USER = Object.freeze({
  status: 403,
  error: 'Forbidden: user belongs to another workspace',
});

/**
 * Does this record belong to the caller's Workspace?
 *
 * Pure, and takes a snapshot rather than an id, so the routes that check
 * ownership inside a transaction — where they hold a `tx.get` snapshot and
 * cannot write a response — use the same rule as the routes that don't.
 */
function belongsToCaller(snap, req) {
  const recordWorkspace = snap.exists ? snap.data().workspaceId : undefined;
  return !!recordWorkspace && recordWorkspace === req.hammerUser?.workspaceId;
}

/**
 * Resolves a Project the caller is entitled to, or refuses the request.
 *
 * Answers the request itself and returns `null` when the Project is out of
 * reach, so a caller reads as:
 *
 *     const projSnap = await loadOwnedProject(req, res, projectId);
 *     if (!projSnap) return;
 *
 * Returns the snapshot on success, because every call site needed the document
 * anyway and would otherwise read it twice.
 *
 * A falsy `projectId` is refused here rather than left to Firestore, which
 * throws on `doc(undefined)` and would turn a refusal into a 500. That is not
 * hypothetical: a report row carrying no `projectId` reaches this path.
 */
async function loadOwnedProject(req, res, projectId) {
  if (!projectId) {
    res.status(UNREACHABLE_PROJECT.status).json({ error: UNREACHABLE_PROJECT.error });
    return null;
  }
  const snap = await db.collection(collections.PROJECTS).doc(projectId).get();
  if (!snap.exists || !belongsToCaller(snap, req)) {
    res.status(UNREACHABLE_PROJECT.status).json({ error: UNREACHABLE_PROJECT.error });
    return null;
  }
  return snap;
}

/**
 * The same refusal as an Error, for the transactional routes that cannot write
 * a response from inside `runTransaction` and throw a `{ status }`-carrying
 * Error for their handler to answer with.
 */
function unreachableProjectError() {
  return Object.assign(new Error(UNREACHABLE_PROJECT.error), {
    status: UNREACHABLE_PROJECT.status,
  });
}

/** As above, for a Monitored User. */
function foreignUserError() {
  return Object.assign(new Error(FOREIGN_USER.error), { status: FOREIGN_USER.status });
}

module.exports = {
  UNREACHABLE_PROJECT,
  FOREIGN_USER,
  belongsToCaller,
  loadOwnedProject,
  unreachableProjectError,
  foreignUserError,
};
