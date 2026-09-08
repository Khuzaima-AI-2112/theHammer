# AGENTS.md

Repository-level guidance for agents and developers working on theHammer.

> **Purpose:** the non-negotiable rules of engagement for developing features in
> The Hammer. These guardrails exist to prevent scope creep, architectural drift,
> and regressions. Every developer and AI agent working on this repository must
> abide by them.

This file is the single source of truth for project rules. The GCP provisioning
runbook that used to live alongside them is now `docs/gcp-setup.md`.

---

## Project Alignment

This local folder (`theHammer`) MUST always and ONLY be linked to the Google
Cloud project ID **`thehammer`**, with one permitted exception: **`hammer-dev`**
is an approved target for testing and development (ADR-0006). All other
`gcloud` configuration, infrastructure references, and `project_id` environment
variables must use `thehammer`.

### Absolute Stop Protocol

If any agent or command attempts to modify this folder to point to a Google
Cloud project other than `thehammer` or `hammer-dev`, STOP immediately and
notify the user.

---

## 1. The "Done When" Rule is Absolute

Every ticket carries an explicit `Done when` condition.

* **Rule:** A task is not complete when the code compiles, nor when the pull
  request is opened. It is only complete when the specific, measurable
  `Done when` condition has been physically verified.
* **Why:** In past sprints, tasks were marked complete because tests passed, but
  they fundamentally missed the architectural constraint (e.g. missing
  pre-multer validation).
* **Source of `Done when`:** the GitHub issue for the ticket
  (see `docs/agents/issue-tracker.md`). *Changed:* this rule previously sourced
  it from `sprintplan2.md`, which now lives in `docs/archives/` and is no longer
  maintained.

## 2. No Silent Scope Creep

You are authorized to build what is explicitly defined in the ticket.

* **Rule:** Do not invent "nice-to-have" features, UI refactors, or new
  middleware unless it is explicitly required to unblock the ticket. If you
  identify a necessary improvement, file it as a separate issue.
* **Why:** Delivery relies on the core workflows (Admin Portal, Analyst Engine).
  Unplanned polishing derails velocity.

## 3. Strict Toolchain Boundary

The architecture is deliberately constrained.

* **Rule:** You may not introduce new databases (e.g. Redis, PostgreSQL,
  MongoDB), new external APIs without review, or fundamentally new programming
  languages to the stack.
* **Allowed stack:**
  - **Backend:** Node.js, Express, Google Cloud Run (Services & Jobs)
  - **Storage:** Google Cloud Storage, Cloud Firestore (Native Mode)
  - **Extension:** Manifest V3, Vanilla JS/HTML/CSS (no React/Vue in the popup)
  - **Portal:** Vanilla JS/HTML, or lightweight frameworks approved in advance

## 4. The Core Loop is Sacred

The extension's primary directive is to immediately and smoothly capture a
screenshot.

* **Rule:** No new feature can block the capture loop.
* **Example:** If the backend `app.thehammer.io` is unreachable, the extension
  *must* fall back to caching the screenshot locally (`chrome.storage.local`).
  The user must never lose a screenshot because an analyst feature went down.

## 5. Git Is the Only Path to Production

A commit is what deploys. Deployment runs through **Cloud Build**, defined in
`cloudbuild.yaml` (11 steps: test → build → push → smoke-test → deploy →
smoke-test), gated behind the project owner's manual approval (ADR-0005).

* **Rule:** Never hand-write or execute ad-hoc `gcloud run deploy` commands
  against production, and never deploy from a developer machine.
* **Why:** every production change must run the test suite and leave a record of
  what was deployed, from which commit, approved by whom. A deploy that git
  cannot account for is not auditable, and an unauditable deploy path is a
  security finding, not a convenience.
* **Emergencies:** roll back, don't deploy. `docs/runbook.md` §1 documents Cloud
  Run revision rollback, which needs no build at all.
* *Changed:* this rule previously read "via GitHub Actions." That is false —
  there is no `.github/` directory in this repository. The pipeline is
  `cloudbuild.yaml`.

> **Open work, not an open question.** `infra/deploy.ps1` is retired for
> production but still present, and its settings have drifted from the pipeline
> (`--min-instances 0`, `--memory 256Mi`, `API_KEY` via `--set-secrets`).
> Reconcile whichever of those production actually needs into `cloudbuild.yaml`
> *before* removing the script. Binary Authorization is now unblocked but needs
> an attestor, a policy and image signing — a ticket, not a flag.
>
> *Changed 2026-09-06:* this used to end "whether a Cloud Build trigger fires on
> push is still unverified (test plan INF-08)". **It fires.** The trigger is
> `buildme`, on push to `main` of `cfroszte/thehammer` — the client repo, which
> is the `client` remote here; `origin` has its push URL set to `DISABLED`, so a
> push to the personal remote deploys nothing. Verified by pushing `cf5ccfc`
> (#105), which queued build `8d351cc2` unprompted; it then waited on the manual
> approval gate (ADR-0005) and ran all 11 steps green. So a push to
> `client/main` is a deploy request, not a backup — INF-08 is closed.

## 6. Consult the "Lessons Learned"

We keep a living document of critical mistakes made during development.

* **Rule:** Review `lessons_learned.md` before starting work. If you encounter a
  new pitfall (a Cloud Build substitution error, a PowerShell quirk, a Chrome
  extension race condition), document it in `lessons_learned.md` in the same
  pull request as the fix.

## 7. No Phantom Infrastructure

Code requires live infrastructure.

* **Rule:** Do not write code that assumes an unauthorized IAM role, a missing
  GCS bucket, or an uncreated Pub/Sub topic exists. If a task requires new GCP
  infrastructure, provision it explicitly via the scripts in `infra/`
  (`setup.ps1` / `setup.sh`, verified by `verify.ps1` / `verify.sh`) and see
  `docs/gcp-setup.md`.
* *Changed:* this rule previously named Terraform. No Terraform exists in this
  repository; infrastructure is provisioned by the `infra/` scripts.

---

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`cfroszte/thehammer`), driven via
the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root.
See `docs/agents/domain.md`.
