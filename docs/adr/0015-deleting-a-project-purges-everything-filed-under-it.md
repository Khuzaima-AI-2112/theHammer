# Deleting a Project purges everything filed under it, immediately

Deleting a Project removed the Project document and its memberships, and
nothing else. On 2026-09-07 the backfill for #102 found what that had cost:
**17 Capture rows and 26 objects in the bucket, left behind by five Projects
deleted in June and August** (#109). The rows were unreachable — every read
path resolves a Capture through its Project — so they were storage nobody could
address, and the images of a Monitored User's screen outlived the work they
belonged to.

The portal even said so. Its confirmation modal read *"Uploads in GCS are not
affected. This action cannot be undone"* — but `git log -S` traces that sentence
to `a618ee8`, the original portal sprint. It described what the code happened to
do; nobody decided it.

**A Purge is now the meaning of deleting a Project**: every child row, and every
object under the Project's `{projectId}/` prefix, removed at once.

## This does not contradict ADR 0010

ADR 0010 recorded the Customer's *"NO, keep infinitely"*. That answered a
question about **time** — should screenshots expire on their own after 90 days
— and the answer is unchanged: nothing rots, and there is no Storage Lifetime.

It did not answer whether a Customer may deliberately throw away their own work.
Reading "keep infinitely" as "no delete may ever work" would mean theHammer
refuses to let its owner remove a Monitored User's screenshots on request, which
is a worse position than the one ADR 0010 was protecting. Retention is about
time; a Purge is about intent. ADR 0010 carries a note pointing here.

## What was decided

- **Full cascade.** Every child row — `uploads`, `reports`, `session_events`,
  `inactivity_events`, `storyboard_drafts`, `project_memberships` — and every
  object under the Project's prefix, images, JSON sidecars and Report videos
  alike. The single-prefix storage layout is what makes this complete rather
  than best-effort: one prefix delete cannot miss an image.
- **Immediate, with no recovery window.** The confirmation is the safety: it
  counts the Captures before it asks, states the number, and requires the
  Project's name to be typed.
- **Children first, the Project document last, and the whole thing re-runnable.**
  While the Project document survives, its children are still addressable, so a
  cascade that dies halfway is a Purge you run again. This is the opposite of
  what the code did, and that ordering is precisely how #109 happened.
- **Every Purge is recorded** — Project id and name, Workspace, who, when, and
  the counts removed. Those five dead Projects were only ever identified by
  their absence, noticed three weeks later during unrelated work.
- **Authority is unchanged.** `requireAdmin`, no new role tier.

## Considered options

**A grace period** — mark the Project deleted, purge it N days later. Rejected:
it is only worth building alongside a restore path, and without one it is the
worst of both, with the data still present, still billed, and still
unrecoverable. The counted, type-the-name confirmation does the same job for a
fraction of the cost.

**A tombstone** — keep the Project document as a deleted marker so its children
stay reachable. A genuine option, and the one to revisit if recoverability ever
matters. Rejected for now as the same cost as a grace period, spread across
every read path.

**Rows now, objects later, via a scheduled sweep.** Rejected outright: it
recreates #109 in a new costume. Rows gone and objects stranded is strictly
worse than today, because today the rows at least name the prefix the images
are under.

## Consequences

- **Screenshots are now destroyable, permanently, by one person in one modal.**
  That is the intended reading of this decision and the sharpest edge in it.
- **`Configured Retention` is gone** — the term and the setting. It described a
  period an Admin could set, no such period ever existed, and `retentionDays`
  was stored, validated and reported while being read by nothing that deletes.
  A glossary entry for a control that has never controlled anything is what
  allowed three contradictory retention numbers to coexist unnoticed. This
  turns most of #29's repair list into deletions rather than corrections.
- **Removing a Monitored User is still not possible** and is not built here.
  The `{projectId}/{userId}/` layout means the same cascade would work per
  person, and under ADR 0008 there is no employee to request it. Recorded so
  the next reader knows it was considered rather than missed.
- **The confirmation modal must count before it asks.** Of five Projects in
  production, three hold no Captures at all and two hold 100 and 17 objects.
  The number is the whole difference between a harmless click and a
  destructive one.
