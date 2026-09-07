'use strict';

const express = require('express');
const { db } = require('../../lib/firestore');
const { requireAdmin } = require('../../middleware/requireAuth');
const collections = require('../../lib/collections');
const { callerWorkspace } = require('../../lib/ownership');

const router = express.Router();

router.get('/dashboard/stats', requireAdmin, async (req, res, next) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    // #101: requireAdmin proves the caller is an Admin, not that they are an
    // Admin *here*, and an Admin with no Workspace at all has nothing to be
    // scoped to (lesson 67).
    const workspaceId = callerWorkspace(req, res);
    if (!workspaceId) return;

    // Each count is an aggregation, so the rows never leave Firestore.
    //
    // Both queries below pair an equality on `workspaceId` with an inequality
    // on a second field, which needs a composite index — and needs it in a way
    // `npm run test:indexes` did not originally notice, because that audit only
    // looked at queries with an `orderBy` (extended in this change). The
    // emulator serves them without one either way, so nothing local will tell
    // you this was missed: see lesson 68.

    // Active Projects (memberCount > 0) in this Workspace
    const activeProjectsSnap = await db.collection(collections.PROJECTS)
      .where('workspaceId', '==', workspaceId)
      .where('memberCount', '>', 0)
      .count().get();

    // Pending Reports (status == 'queued' or 'processing') in this Workspace
    //
    // #103 stamped `reports` the same way #102 stamped `uploads` (ADR 0014).
    //
    // What is known: a (workspaceId, status) index is declared, deployed and
    // built, and the readiness probe confirms this exact shape serves against
    // the live project (2026-09-07).
    //
    // What is *not* known: whether it needs that index. `in` is a disjunction
    // of equalities rather than an inequality, and Firestore can serve
    // equality-only filters by merging single-field indexes — so the composite
    // may be doing nothing. Do not read the deploy timings as evidence either
    // way: this shape probed READY while the `uploads` one spent four minutes
    // BUILDING, but `reports` was empty and an index over no documents builds
    // instantly, so collection size explains that difference on its own.
    //
    // Settling it means dropping the index and re-probing, which is not worth
    // doing to save one index on a collection this small. Left declared.
    //
    // Note also that `npm run test:indexes` cannot see this query at all: its
    // parser knows equality+orderBy and equality+inequality, so it stays green
    // whether or not any index exists. The probe is the only thing that
    // answers questions in this area, and it only answers the one it was
    // asked (lesson 68).
    const pendingReportsSnap = await db.collection(collections.REPORTS)
      .where('workspaceId', '==', workspaceId)
      .where('status', 'in', ['queued', 'processing'])
      .count().get();

    // Captures Today, in this Workspace
    //
    // #102 stamped `uploads` with a denormalised `workspaceId` (ADR 0014), so
    // this filters the field directly rather than resolving the Workspace's
    // Projects and using `in` — which Firestore caps at 30 values, making the
    // tile's cost a function of how many Projects the Customer runs.
    //
    // A Capture written before that stamp carries no `workspaceId` and is
    // therefore counted by nobody until the backfill reaches it. That is the
    // deliberate reading of absent (lesson 67), and why
    // scripts/workspace-stamp-backfill.js ships with the field rather than after
    // it.
    const capturesTodaySnap = await db.collection(collections.UPLOADS)
      .where('workspaceId', '==', workspaceId)
      .where('uploadedAt', '>=', startOfDay)
      .count().get();

    // #100 removed a fifth count here, over a collection nothing writes; see
    // lesson 69. If asynchronous Exports are ever built, this is a new tile
    // rather than a restored one.

    // Active Users Today in this Workspace
    const activeUsersTodaySnap = await db.collection(collections.USERS)
      .where('workspaceId', '==', workspaceId)
      .where('lastActiveAt', '>=', startOfDay)
      .count().get();

    return res.json({
      activeProjects: activeProjectsSnap.data().count,
      activeUsersToday: activeUsersTodaySnap.data().count,
      capturesToday: capturesTodaySnap.data().count,
      pendingReports: pendingReportsSnap.data().count,
    });

  } catch (err) {
    next(err);
  }
});

module.exports = router;
