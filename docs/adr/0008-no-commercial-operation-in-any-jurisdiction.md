# theHammer is not operated commercially in any jurisdiction

theHammer was built to be sold to Customer organisations that monitor their own
staff. The Customer withdrew from that on 2026-08-24, having looked at what EU
and UK data protection law would cost to satisfy, and extended it on 2026-08-25:
North America is not considered safe to operate this kind of business in either.
There is no target market left. theHammer continues as a tool the Customer and
the developer run on their own machines, and the Customer has asked that
development carry on.

This supersedes two earlier decisions, neither of which has anything left to
apply to:

- **ADR 0001, the Customer is the data controller.** It assigned responsibility
  for monitoring to each paying Customer organisation. There are none.
- **ADR 0002, launch to North America only.** It was a contractual sales
  restriction. Nothing is being sold.

## Considered options

Doing the EU/UK compliance work properly — funded legal review, Disclosure,
retention, data subject requests — was the Customer's alternative and they
priced it and declined. That is their call to make and it was made on cost, not
on a reading of the law that this repository disputes.

Stopping work altogether was not chosen. The Customer asked for development to
continue.

## Consequences

The exposure that remains is not regulatory, it is practical, and it moved
rather than disappeared. Whoever runs theHammer sends screenshots of their own
screen to Google's AI, which reads the text on them. If either of us runs it
while working on someone else's material — the Customer's codebase, a client's
work — that third party's material goes to Google without their agreement. They
are not party to any of this and no terms cover them. Open with the Customer in
`deliverables\to-questionnaire-what-still-need-answering.md`, questions 2 and 3.

Product work does not all disappear with the market. The Disclosure screen is
still described in the architecture and still expected by other parts of the
app; the retention setting still offers ten years while storage deletes at 90
days, which is now simply a defect rather than a compliance one. Whether the
Disclosure screen is still built is open with the Customer.

Nothing in this decision permits monitoring anyone who has not agreed to it. It
narrows theHammer to two consenting users, and that is the only footing it now
has.
