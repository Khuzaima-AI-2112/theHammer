# `workspaceId` is denormalised onto Project-child records

Grilled 2026-09-06, ahead of
[#98](https://github.com/Khuzaima-AI-2112/theHammer/issues/98).

## Decision

`uploads` and `reports` carry a denormalised `workspaceId`, stamped at write
time from the Project the caller has already been proved to own. Any query that
needs to count or list those records for one Customer filters on that field
directly, rather than resolving the Workspace's Projects first and filtering on
their ids.

## Why

`GET /admin/dashboard/stats` counts five collections and scopes none of them,
so an Admin sees every Customer's business volume. `projects` and `users`
already carry `workspaceId`; `uploads` and `reports` carry only a `projectId`,
which left two ways to scope them.

The alternative was an `in` filter over the Workspace's Project ids. It needs
no schema change and no migration, but Firestore caps `in` at 30 values, so a
Workspace with more Projects than that has to be chunked into ⌈n/30⌉ counted
queries per tile — the Dashboard's cost becomes a function of how many Projects
the Customer runs, permanently, in exchange for avoiding a one-off migration.

That migration is as cheap as it will ever be: production currently holds one
user and effectively no rows. Paying a standing query cost to dodge a
near-zero one-off cost is the wrong trade, and it is the wrong trade in a
specific way — `lessons_learned.md` #67 records that *a missing scope field and
a missing scope check are the same defect*. The `in` filter fixes the check and
leaves the field missing.

Two things also made the stamp cheaper than it looks. Both upload paths
(`backend/src/index.js`, `/upload-url` and `/capture`) already load the Project
and compare its `workspaceId` to the caller's before writing, so the value is
in hand at the moment of the write and costs no extra read. And
`storyboard_drafts` has carried a denormalised `workspaceId` since #88 — this
decision finishes a pattern the codebase had already started, rather than
introducing one.

## What this means concretely

- **Every writer of a stamped collection must set the field.** There is one
  writer of `uploads` (`firestoreWrite` in `backend/src/index.js`) and three of
  `reports` (`routes/admin/reports.js`, and two in `routes/admin/storyboards.js`).
- **An absent `workspaceId` means the record belongs to nobody**, never to
  whoever asked (#67's fourth rule). Records written before this ADR are
  therefore unreachable until backfilled, which is why the backfill ships in
  the same change as the field.
- **The stamp does not travel further than a reader requires.**
  `session_events` and `inactivity_events` are also Project-children and are
  deliberately left unstamped: nothing reads them across Projects today, and
  speculative schema is how a field ends up half-written. **Any new
  Project-child collection is born with the stamp** — that is the rule this ADR
  exists to state, and it is what keeps the schema from staying half-stamped by
  accident.
- **New composite indexes are required** and, per #68, arrive only through a
  separate `firebase deploy --only firestore:indexes`. Nothing in
  `cloudbuild.yaml` deploys them.

## Considered and rejected

**The `in` filter over Project ids** — described above. Worth revisiting only
if the backfill cost ever came to exceed the standing query cost, which is the
opposite of the situation today.

**Stamping every Project-child collection at once** — rejected as speculative;
see the rule above, which is the cheaper way to get the same guarantee.
