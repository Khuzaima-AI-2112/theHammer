# Changing project ends the Session, once a capture lands against the new one

A Session is theHammer's unit of counted working time, and every time metric in
`docs/architecture.md` §12 is built from the `session_events` documents it
writes. The architecture document described a Session two ways — bound to one
project, and lasting as long as the browser is open — which produce different
apps. The Customer settled it on 2026-08-25: **changing project ends the
Session and starts a new one**, so each project's time is cleanly separated.

The Customer also asked that a switch made by mistake and reversed straight
away count as one Session rather than three. A project change therefore does
not become a Session boundary by itself. **The boundary commits when the first
capture lands against the new project**, and not before.

That rule needs no timer and no threshold, because a Session only ever moves on
a capture: `sessionOnCapture()` is the sole writer of Session state. A person
who switches project and switches back without capturing anything never reaches
that code, so their Session continues unbroken with one `sessionId` — which is
exactly the outcome the Customer asked for, arrived at by leaving the state
alone rather than by unwinding it afterwards.

The extension's action badge says a new Session has started at the moment the
boundary commits, not when the project changed. Announcing it at the change
would be announcing something that may never happen.

## Considered options

Letting a Session span projects and dividing its time afterwards was rejected:
it is more to build and it raises a further question, how a report decides how
much of one Session belongs to each project, that nobody needs answered.

Committing the boundary the instant `projectId` differs was proposed to the
Customer and rejected by them. It keeps the reports literal and costs nothing to
build, but it puts five-second Sessions in the middle of an hour's work.

A settle period — hold the boundary for 60 seconds and discard it if the project
returns — was drafted and then dropped as unnecessary. It would have added a
timer, a constant nobody chose, and state to reconcile across service worker
restarts, to reproduce what capture-driven commit gives for free. The two rules
differ only for a switch that is captured against and then reversed, which is
not a mistake and should be two Sessions under either reading.

## Consequences

The Session being replaced must be flushed before the new one starts — today it
is discarded, so an hour of work vanishes from the reports whenever someone
switches project (#17). That is the first piece of this work.

A flush that fails at a project boundary loses the outgoing Session for good:
unlike the `suspend` and `window_removed` flushes it has no second trigger to
retry from, because the state it would retry against is about to be overwritten.
The capture loop must not be blocked waiting on it (AGENTS.md rule 4), so the
failure is logged loudly and the capture proceeds. Queuing `session_events` for
retry the way uploads already are is a separate piece of work (#22).

Reports that were read before this ships were low wherever a project switch
occurred, with nothing on the page to say so.
