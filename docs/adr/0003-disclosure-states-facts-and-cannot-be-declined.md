# The Disclosure states facts; it is not a consent agreement

> **Superseded on 2026-08-25 by ADR 0011.** There is no Disclosure screen.
> theHammer is an internal tool and the people it captures are the people
> running it, so this decision has nothing left to apply to.

theHammer shows a Monitored User what is collected before any Capture is
possible, and they cannot decline it and keep using the extension. We decided to
be explicit about that rather than dress it up: the Disclosure is a statement of
fact from theHammer, not an offer the Monitored User can refuse. Its wording
says the employer has enabled monitoring, not that the user is opting in.

Two things follow. Acknowledgement is a condition of use, so there is no decline
path and none should be added. And the factual core of the text — what is
collected, that Capture contents are processed by an AI model, that device idle
and lock state is detected — is written by theHammer and is not editable by a
Customer, who may add only a preamble and a link to their own policy.

## Considered options

Making Acknowledgement a genuine choice was rejected: an employee cannot freely
refuse their employer, so a decline button would be theatre, and building the
untracked mode it implies is work with no buyer. Letting Customers edit the full
text was rejected because a Customer could soften or falsify what theHammer
collects, and theHammer would be the one displaying it.

## Consequences

The button must not read as consent. Anyone rewording this screen should treat
the factual core as fixed content, not copy. See ADR-0001 for why the obligation
to give notice sits with the Customer even though the mechanism is ours.
