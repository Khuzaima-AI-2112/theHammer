# Acknowledgement records are server-side, versioned, and exempt from Storage Lifetime

> **Superseded on 2026-08-25 by ADR 0011.** With no Disclosure screen there is
> no Acknowledgement to record. Its exemption from the Storage Lifetime is moot
> twice over — ADR 0010 removes the Storage Lifetime as well.
>
> *Amended 2026-09-07 (#29, #112).* The Storage Lifetime is now gone from the
> code as well as from the decision: `retentionDays`, the lifecycle rule and the
> setting that appeared to control them were deleted rather than corrected. So
> the exemption below is an exemption from nothing, and the Consequences
> section's warning — "do not bring it under the 90-day Storage Lifetime" —
> names a rule that no longer exists to be brought under.
>
> **What did not survive unchanged is the principle.** ADR 0015 makes deleting a
> Project a Purge: every record filed under it goes, immediately and
> irreversibly. That is about intent rather than time, so it is not the Storage
> Lifetime returning under another name — but it *is* a way for Captures to be
> destroyed, and this ADR's claim is that evidence of notice must outlive the
> data the notice was about. Those two would collide if an Acknowledgement were
> ever filed under a Project.
>
> Today they cannot, because there are no Acknowledgements: no `acknowledgements`
> collection exists and nothing writes one, per ADR 0011. The question is
> therefore open rather than answered. **If a Disclosure is ever reinstated, the
> Acknowledgement must not be filed under a Project** — a Purge would take it,
> and the evidence would die with the thing it was evidence about. Store it
> against the Workspace instead, which nothing purges.

An Acknowledgement is the Customer's evidence that a Monitored User was told
what is collected. We decided to store it server-side in Firestore against user,
Workspace, Disclosure Version and timestamp — not in browser storage, and not
subject to the 90-day Storage Lifetime that applies to Captures.

## Considered options

`docs/architecture.md` §5 proposes recording acceptance "locally (and optionally
in Firestore)". Local-only was rejected because clearing browser data destroys
the evidence, and the party who needs it — the Customer — has no access to the
Monitored User's machine.

## Consequences

This record is deliberately outside the retention rules that govern Captures.
Do not "fix" it by bringing it under the 90-day Storage Lifetime: evidence that
notice was given must outlive the data the notice was about. Storing the
Disclosure Version is what makes §5.1's re-prompt on material change work, since
there is otherwise nothing to compare the current text against.
