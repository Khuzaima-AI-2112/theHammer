# `hammer-dev` is a permitted deploy and test target

The Absolute Stop Protocol forbade pointing this repository at any Google Cloud
project other than `thehammer`, which made the `hammer-dev` project named
throughout the architecture and testing documents unreachable. We decided
`hammer-dev` is explicitly permitted for testing and development, and the rule
now names it as the one allowed exception.

## Considered options

Removing `hammer-dev` from the other documents instead was rejected: testing
against the live project is the outcome the rule was written to prevent, so
enforcing it literally would have produced the exact risk it guards against.

## Consequences

The Absolute Stop Protocol still applies to every other project ID, and that is
the point of narrowing it rather than deleting it — an agent pointing this repo
at an unrelated project is still a stop-and-notify event.
