# The Hammer — Developer Guardrails

> **Purpose:** This document establishes the non-negotiable rules of engagement for developing features in The Hammer. Sprints are short and fast; these guardrails exist to prevent scope creep, architectural drift, and regressions.

Every developer and AI agent working on this repository must abide by these rules.

---

## 1. The "Done When" Rule is Absolute
Every task in `sprintplan2.md` has an explicit `Done when` condition.
* **Rule:** A task is not complete when the code compiles, nor when the pull request is opened. It is only complete when the specific, measurable `Done when` condition has been physically verified.
* **Why:** In past sprints, tasks were marked complete because tests passed, but they fundamentally missed the architectural constraint (e.g., missing pre-multer validation).

## 2. No Silent Scope Creep
You are authorized to build what is explicitly defined in the sprint plan.
* **Rule:** Do not invent "nice-to-have" features, UI refactors, or new middleware unless it is explicitly required to unblock a sprint task. If you identify a necessary improvement, document it in the backlog.
* **Why:** The project timeline relies on delivering the core workflows (Admin Portal, Analyst Engine). Unplanned polishing derails the sprint velocity.

## 3. Strict Toolchain Boundary
The architecture is deliberately constrained. 
* **Rule:** You may not introduce new databases (e.g., Redis, PostgreSQL, MongoDB), new external APIs without review, or fundamentally new programming languages to the stack.
* **Allowed Stack:** 
  - **Backend:** Node.js, Express, Google Cloud Run (Services & Jobs)
  - **Storage:** Google Cloud Storage, Cloud Firestore (Native Mode)
  - **Extension:** Manifest V3, Vanilla JS/HTML/CSS (No React/Vue inside the popup)
  - **Portal:** Vanilla JS/HTML or lightweight frameworks explicitly approved in advance.

## 4. The Core Loop is Sacred
The extension's primary directive is to immediately and smoothly capture a screenshot. 
* **Rule:** No new feature can block the capture loop. 
* **Example:** If the backend `app.thehammer.io` is unreachable, the extension *must* fall back to caching the screenshot locally (`chrome.storage.local`). The user must never lose a screenshot because an analyst feature went down.

## 5. Deployments are CI/CD Only
We deploy to Google Cloud Project environments via GitHub Actions.
* **Rule:** You are working remotely on GitHub. Do not attempt to write or execute manual `gcloud run deploy` commands or assume you have local access to the GCP production environment. 
* **Why:** All infrastructure changes and code deployments must flow through Pull Requests and our automated CI/CD pipelines to ensure the `thehammer` and `hammer-dev` environments remain protected.

## 6. Consult the "Lessons Learned"
We keep a living document of critical mistakes made during development.
* **Rule:** Review `lessons_learned.md` before starting your sprint. If you encounter a new pitfall (e.g., a Cloud Build substitution error, a PowerShell quirk, a Chrome extension race condition), you must document it in `lessons_learned.md` in the exact same Pull Request as the fix.

## 7. No Phantom Infrastructure
Code requires live infrastructure. 
* **Rule:** Do not write code that assumes an unauthorized IAM role, missing GCS bucket, or uncreated Pub/Sub topic exists. If a task requires a new piece of GCP infrastructure, it must be provisioned via Terraform / `gcloud` scripts explicitly, rather than assumed.
