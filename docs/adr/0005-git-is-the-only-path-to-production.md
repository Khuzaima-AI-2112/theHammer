# Git is the only path to production; ad-hoc desktop deploys are closed

theHammer had two deploy paths. `cloudbuild.yaml` runs tests, builds, smoke-tests
and deploys. `infra/deploy.ps1` deploys straight from a developer's machine,
skipping the tests entirely, and Binary Authorization was switched off on purpose
to keep that possible. We decided the pipeline is the only path: a commit is what
deploys, gated behind the project owner's manual approval, and `deploy.ps1` is
retired for production use.

This is not a new position. The client proposal already states that a new commit
triggers Cloud Build behind manual approval, and the cost estimate already states
that there are no manual deploys to the live project. The code simply did not
match what was promised.

## Considered options

Keeping the desktop path for emergencies was rejected. An emergency is precisely
when untested code is most dangerous, and `docs/runbook.md` §1 already documents
a Cloud Run revision rollback — which is the correct emergency lever, and does
not require a build at all.

## Consequences

Retiring `deploy.ps1` is not just a deletion. The two paths had drifted: the
script sets `--min-instances 0`, `--memory 256Mi` and injects `API_KEY` via
`--set-secrets`, none of which the pipeline does. Whichever of those settings
production actually needs must be reconciled into `cloudbuild.yaml` first, or the
deployed service silently changes shape on the next build. Which config is live
today cannot be determined from this repository.

Binary Authorization can now be enabled, but it is real work — an attestor, a
policy, and Cloud Build signing its images — not a flag. It is a separate ticket,
and this decision is what unblocks it.
