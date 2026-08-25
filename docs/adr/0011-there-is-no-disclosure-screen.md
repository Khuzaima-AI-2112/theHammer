# There is no Disclosure screen

The Disclosure was the screen a Monitored User saw before any Capture was
possible, telling them what was collected. It existed because theHammer was
workplace monitoring sold to employers, and the person being watched had not
chosen to be. It was described in the architecture document and never built.

Asked on 2026-08-25 whether it was still wanted, the Customer said no:
*"no privacy disclosure needed. This is an internal product."*

**It is not being built, and the decisions supporting it lapse.** The two people
running theHammer are the two people it captures. There is nobody to disclose
to who does not already know.

This supersedes:

- **ADR 0003, the Disclosure states facts and cannot be declined.** It settled
  how to word a screen that will not exist.
- **ADR 0004, Acknowledgement records are server-side and outlive Captures.** An
  Acknowledgement was the Customer's evidence that a Monitored User had been
  shown the Disclosure. With no Disclosure and no Monitored User there is
  nothing to evidence. Its exemption from the 90-day Storage Lifetime is doubly
  moot — ADR 0010 removes the Storage Lifetime as well.

## What still needs doing

`docs/architecture.md` still describes the Disclosure and the Acknowledgement as
parts of the system. Leaving a described-but-absent screen in the architecture
is the kind of gap that sends the next person looking for code that was never
written. The description should be removed, with a pointer here. That belongs
with the other documentation corrections on #9.

## Considered options

**Building it anyway, for tidiness** — the position argued when the question was
put, on the grounds that other parts of the app expect it to exist and a
described-but-missing screen causes confusion later. The Customer chose not to,
and the confusion is cheaper to fix by correcting the description than by
building a screen for an audience of nobody.
