# sprintplan2.md — Blocking Issues Audit
**Reviewer:** Senior GCP Architect / SRE  
**Date:** 2026-06-16  
**Verdict:** 14 blocking issues identified across 4 categories. None are cosmetic — each one will either prevent a developer from implementing a feature correctly or cause a runtime failure.

---

## Category A — Phantom File References (Hallucinated Documents)

These files are cited as authoritative sources of truth in sprintplan2.md but **do not exist in the repo**. Any developer who tries to follow the plan will hit a dead end immediately.

| # | Reference in sprintplan2.md | Does it exist? | Impact |
|---|---|---|---|
| **A1** | `arch_decisions.md` — cited 11 times as the canonical source for every resolved decision (IAP auth, FFmpeg topology, CORS, SLOs, alert thresholds §6.3, key storage) | ✅ EXISTS (30 KB) | Not blocking — file is real |
| **A2** | `sprint21.md` — cited as prerequisite; all networking/LB/Cloud Armor work delegated there | ✅ EXISTS (15 KB) | Not blocking — file is real |
| **A3** | `projectplan.md` — tasks 6S S.2, S.6, and 9.1 say "decision written in `projectplan.md`" | ✅ EXISTS (8 KB) | Not blocking — file is real |
| **A4** | `runbook.md` — task 9.14 says "create `runbook.md`" | **❌ DOES NOT EXIST** | **Blocking for 9.14 done-when verification** |
| **A5** | `data-classification.md` — backlog item says "create before first external user onboarded" | **❌ DOES NOT EXIST** | Soft-blocking — no sprint owns its creation |
| **A6** | `firestore.indexes.json` — tasks 5.8 and 6.11 reference this file as where composite indexes are declared | **❌ DOES NOT EXIST** | **Hard blocking** — indexes will not be deployed; queries in 5.8 and 6.11 will fail or be unbounded full-collection scans |
| **A7** | `scripts/smoke-test.sh` — task 9.6 done-when condition is this file running and exiting 0 | **❌ DOES NOT EXIST** | **Hard blocking for 9.6** — no smoke test can be verified |
| **A8** | `infra/cloud_run.tf` — task 9.12 (Binary Authorization) says "added to `infra/cloud_run.tf`" | **`infra/` directory exists but is empty** | **Hard blocking for 9.12** — Terraform file doesn't exist; Binary Authorization cannot be applied |

---

## Category B — Vague / Unimplementable Specs

These tasks have done-when conditions that a developer cannot evaluate objectively.

| # | Task | The vagueness | Why it blocks |
|---|---|---|---|
| **B1** | **5.1** — Schema documented in `projectplan.md` | No field-level schema is defined anywhere in sprintplan2.md. What fields does a `projects` doc have? `users`? `project_memberships`? The "3 example JSON docs" done-when is the entire spec. | Developer must guess field names; Firestore security rules in 9.11 cannot be written without knowing what fields exist |
| **B2** | **7.7** — Executive Summary "Before/After narrative filled from Firestore data using a Markdown template" | What Firestore fields constitute "Before"? What constitutes "After"? What does the Markdown template look like? "LLM fill is an optional enhancement" but no fallback template is provided. | Developer has no idea what to render; report will ship as an empty page or stub |
| **B3** | **8.4** — "Import Executive Summary maps report paragraphs to slides by timestamp proximity" | "Timestamp proximity" is undefined. Proximity to what timestamp — `uploadedAt` on the upload doc? `sessionStart`? Within how many seconds is "proximate"? | Unmappable without an algorithm spec; any implementation will be arbitrary and produce nonsense mappings |
| **B4** | **9.3** — Role assignment "propagates within 10 s" | The plan says "no cache to invalidate — lookup is per-request." If lookup is per-request against Firestore, propagation is immediate (< 1 s). The "10 s" figure contradicts the no-cache claim and is unexplained. | Acceptance test cannot be written; dev doesn't know if caching is intended or not |
| **B5** | **9.4** — "Rate limit state in memory (single Cloud Run instance) or Firestore counter if multi-instance" | This is a fork with no decision criterion. When does Cloud Run go multi-instance? There is no `--max-instances 1` declaration anywhere in the plan. At any non-trivial load, Cloud Run will auto-scale and in-memory rate limiting silently stops working. | Rate limiting will be broken in production; the developer is given an escape hatch ("or Firestore") with no trigger |
| **B6** | **9.8** — "Export queue depth alert: log-based metric via Cloud Function" | Why is a Cloud Function needed for a Firestore count? This is either wrong (Cloud Monitoring has native Firestore metrics) or the spec is describing a custom metric that needs a full implementation — but that implementation is not a task in the sprint. | Alert will not be built; developer is blocked deciding whether to use a Cloud Function or a log-based metric filter |
| **B7** | **9.13** — Key rotation "emails new key" | No email service is specified anywhere in the plan (no SendGrid, no Mailjet, no SMTP, no Cloud SendGrid, no Gmail API). The extension → Cloud Run stack has no email sending infrastructure. | Task cannot be implemented; email delivery mechanism is a phantom dependency |

---

## Category C — Internal Contradictions (Plan Fights Itself)

These are places where two parts of the plan give conflicting instructions. A developer following one section will break another.

| # | Contradiction | Section A | Section B | Blocking effect |
|---|---|---|---|---|
| **C1** | **Firestore schema: flat vs. subcollection** | Architecture table says "flat `uploads` collection with `projectId` field; **no subcollections**" | Task 5.5 says "`DELETE /admin/projects/:id` deletes project doc + all `project_memberships` **subcollection** docs in a batched write" | `project_memberships` is either a top-level collection (flat) or a subcollection of `projects`. The delete query is completely different in each case. One of these is wrong. |
| **C2** | **Cloud Tasks → Cloud Run Job routing** | Architecture table + FFmpeg section says "`hammer-export` is a Cloud Run **Job**, not a Service" | Task 8.5 says `POST /export/video` "enqueues Cloud Tasks task targeting `hammer-export` Cloud Run Job" | Cloud Tasks **cannot target a Cloud Run Job directly**. Cloud Tasks targets a Cloud Run Service URL. To trigger a Job, you need a Service endpoint that calls the Jobs API. This intermediate Service or endpoint is not defined anywhere. |
| **C3** | **Admin Portal auth: IAP vs. `X-Api-Key`** | Task 5.13: Portal is protected by Cloud IAP; `hammer-api` reads `X-Goog-Authenticated-User-Email` header | Tasks 7.3 and 8.11: analyst and ID role enforcement use `sha256(req.headers['x-api-key'])` checked against `api_keys` collection | The Report Viewer (7.12) is in the Admin Portal SPA — does it call `/reports/*` with an IAP-injected identity or an API key? The `sha256` middleware in 7.3 will reject IAP-authenticated requests. The auth path for SPA → API calls is never specified. |
| **C4** | **`sessionId` — undefined generation** | Tasks 6.2 and 6.3 require `sessionId` on all `session_events` docs | Nowhere in the plan is `sessionId` defined — how it's generated (`uuid`, `crypto.randomUUID()`, Firestore auto-id?), where it's created, or how the extension and backend coordinate on the same value | Firestore write in 6.3 will produce docs with different or missing `sessionId` values; joins between `session_events` and `inactivity_events` are impossible |
| **C5** | **`hammer-api` is never explicitly deployed in Sprint 5** | Task 5.14 deploys `hammer-portal` with a 10% canary and a done-when condition | All new `/admin/*` routes live in `hammer-api`, but there is no "deploy `hammer-api`" task in Sprint 5 with a done-when condition | New admin routes are never deployed; the portal SPA will receive 404 on every API call until someone notices |

---

## Category D — Missing Prerequisites That Will Silently Break Features

These are gaps where a required upstream thing is never created, but the task that depends on it has a done-when condition that looks passable until runtime.

| # | Missing piece | Who depends on it | Runtime failure |
|---|---|---|---|
| **D1** | No Firestore composite index `(projectId ASC, userId ASC, uploadedAt DESC)` is defined for task 6.11 | Task 6.11 activity timeline gap rendering | Firestore returns "The query requires an index" error at runtime; gap highlighting never renders |
| **D2** | No GCS CORS configuration task for `hammer-screenshots-{PROJECT_ID}` bucket | Task 5.11 thumbnail loading in Admin Portal SPA | Thumbnails fail with CORS error in browser; bucket CORS is only specified for `hammer-exports` (task 8.9) |
| **D3** | `chrome.runtime.connect` keepalive port (mentioned in task 6.10) is never implemented as a task | Task 6.10 service worker keepalive | SW will be suspended after ~30 s of inactivity; `chrome.alarms` will fire but the handler won't be in memory — the exact failure the task is supposed to prevent |
| **D4** | No task creates the `hammer-reports-{PROJECT_ID}` GCS bucket | Tasks 7.5, 7.6, 7.7, 7.8–7.11 all write to this bucket | All report generation fails with `404 bucket not found` on first execution |
| **D5** | No task grants `hammer-api` service account `roles/storage.objectAdmin` on `hammer-screenshots-{PROJECT_ID}` | Tasks 5.11 (signed URL generation), 7.8–7.11 (OCR reads) | Signed URL generation fails with permission denied; IAM grant exists only for `hammer-export-sa` on `hammer-exports-{PROJECT_ID}` |

---

## Severity Summary

| Severity | Count | Issues |
|---|---|---|
| 🔴 Hard-blocking (app cannot function) | 9 | A4, A6, A7, A8, C1, C2, C5, D1, D4 |
| 🟠 Logic-breaking (ships broken silently) | 6 | B5, C3, C4, D2, D3, D5 |
| 🟡 Blocking at acceptance | 5 | B1, B2, B3, B4, B7 |
| ℹ️ Soft / future-blocking | 2 | A5, B6 |

---

## Recommended Fixes (in priority order)

1. **Fix C2 first** — decide whether Cloud Tasks triggers a Cloud Run Service endpoint (which then calls the Jobs API) or calls the Jobs API directly from `hammer-api`. Add the trigger service or endpoint as an explicit task.
2. **Fix C1** — pick flat vs. subcollection for `project_memberships` and update the task 5.5 delete query accordingly.
3. **Fix C3** — specify the auth mechanism for SPA → `/reports/*` calls: either extend IAP to pass an identity token the middleware accepts, or document that the Admin user gets an API key with `role: admin` and uses it from the SPA.
4. **Create `firestore.indexes.json`** with all composite indexes (5.8, 6.11, Sprint 7 aggregation) and add a deploy task in each affected sprint gate checklist.
5. **Add D4 + D5 as explicit infra tasks** — bucket creation and IAM grant for `hammer-reports-{PROJECT_ID}` and `hammer-screenshots-{PROJECT_ID}`.
6. **Resolve B5** — either set `--max-instances 1` on `hammer-api` and document the tradeoff, or commit to Firestore-backed rate limiting unconditionally.
7. **Define `sessionId` generation** in the extension service worker and add it to the 6.1 done-when condition.
8. **Add GCS CORS task for `hammer-screenshots-{PROJECT_ID}`** — currently only `hammer-exports` has a CORS task.
9. **Remove the email claim from 9.13** or add an email infrastructure task (Cloud SendGrid API key in Secret Manager, sender domain verified) as a prerequisite.
10. **Add a `hammer-api` canary deploy task to Sprint 5** with the same done-when structure as 5.14.
