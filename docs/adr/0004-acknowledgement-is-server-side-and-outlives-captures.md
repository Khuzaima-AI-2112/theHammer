# Acknowledgement records are server-side, versioned, and exempt from Storage Lifetime

> **Superseded on 2026-08-25 by ADR 0011.** With no Disclosure screen there is
> no Acknowledgement to record. Its exemption from the Storage Lifetime is moot
> twice over — ADR 0010 removes the Storage Lifetime as well.

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
