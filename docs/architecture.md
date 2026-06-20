# The Hammer — Production Architecture Decisions
## Senior GCP Architect & SRE Recommendations

_Optimal answers to every open question in `arch_questions.md`, scoped to a small-team B2B SaaS product on GCP (Cloud Run · Firestore · GCS · Secret Manager). Recommendations balance production correctness with implementation velocity._

> **Final Calls recorded 2026-06-16**
> - **1B** — Export trigger: `hammer-export-trigger` as a dedicated Cloud Run Service (HTTP-triggered, not a Job)
> - **2A** — Firestore location: flat top-level collection (`uploads`, `session_events`, etc.) with `projectId` field
> - **3A** — SPA auth: Cloud IAP identity token (not Firebase Auth or custom JWT)

---

## 1. Compute & Cloud Run

### 1.1 Service Topology

**Final Call 1B — Export trigger: `hammer-export-trigger` dedicated Cloud Run Service**

Four Cloud Run services, not three + a Job:

| Service | Purpose | `--min-instances` | `--max-instances` | Concurrency |
|---|---|---|---|---|
| `hammer-api` | Capture ingest, admin CRUD, auth middleware | 1 | 20 | 80 |
| `hammer-portal` | Admin/Analyst/ID SPA (static files via Nginx) | 0 | 5 | 80 |
| `hammer-export-trigger` | HTTP-triggered export orchestrator; enqueues Cloud Tasks, returns job ID | 0 | 10 | 80 |
| `hammer-export-worker` | Cloud Run Job executed per storyboard; runs FFmpeg; 1 task per execution | N/A | N/A | 1 |

**Why `hammer-export-trigger` as a Service, not merged into `hammer-api`:**
- Keeps the main API's response-time SLO clean — export enqueue is fire-and-forget, but it talks to Cloud Tasks and Firestore and should not share the capture endpoint's error budget
- Can be scaled, deployed, and IAM-scoped independently from the API
- Allows rate-limiting the `/export/video` surface without touching the capture hot-path

**Why `hammer-export-worker` remains a Cloud Run Job:**
FFmpeg renders are discrete, bounded tasks — not long-running servers. Cloud Run Jobs are billed only for execution time, require no HTTP server, and each job execution maps cleanly to one storyboard export. `hammer-export-trigger` enqueues job executions via the Cloud Run Jobs API (not Cloud Tasks). Set `--task-timeout 1800s` with a hard 50-slide ceiling enforced before FFmpeg starts.

**Q: Cloud Run Job vs Service for the worker?**
**A: Cloud Run Job for `hammer-export-worker`.** The trigger Service handles HTTP; the worker Job handles FFmpeg. This is the correct GCP-native separation of concerns.

**Q: Maximum request timeout?**
**A:** `hammer-api` → 300 s; `hammer-portal` → 60 s; `hammer-export-trigger` → 30 s (returns job ID immediately); `hammer-export-worker` Job → 1800 s.

**Q: HTTP/2 or gRPC?**
**A: REST over HTTPS throughout.** For real-time dashboard updates, use Firestore `onSnapshot` listeners from the browser.

---

### 1.2 Scaling & Traffic

**Q: Expected concurrent users?**
**A: 5–20 steady state, 50 at peak.** Set `--max-instances 20` on `hammer-api`; adjust after 30 days of production metrics.

**Q: Concurrency per instance?**
**A:** `hammer-api`: 80. `hammer-portal`: 80. `hammer-export-trigger`: 80. `hammer-export-worker` Job: **1** (FFmpeg is CPU-bound).

**Q: Serverless VPC Access connector?**
**A: No**, unless compliance requires it. Firestore and GCS are accessed via Google's public APIs over TLS.

**Q: Domain mapping?**
**A: Custom domain via Global HTTPS Load Balancer + Google-managed SSL cert.**

---

## 2. Networking & Ingress

### 2.1 Load Balancing

**Q: CLB or direct Cloud Run URLs?**
**A: Global HTTPS Load Balancer with Serverless NEGs.**

```
LB Frontend: HTTPS :443 → URL Map
  /api/*      → Backend: hammer-api             (Serverless NEG, us-central1)
  /export/*   → Backend: hammer-export-trigger  (Serverless NEG, us-central1)
  /*          → Backend: hammer-portal          (Serverless NEG, us-central1)
```

**Q: Cloud Armor?**
**A: Yes — basic policy on Day 1.** Rules: `sqli-stable`, `xss-stable`, rate limit 100 req/min/IP. Cost: $5/month.

---

### 2.2 DNS & TLS

**Q: DNS provider?**
**A: Cloud DNS as the authoritative nameserver.**

**Q: SSL certs?**
**A: Google-managed certificates via Certificate Manager.**

**Q: Subdomain topology?**
**A: Path-routing under one domain.**
```
app.thehammer.io/         → Admin Portal SPA (hammer-portal)
app.thehammer.io/api/     → REST API (hammer-api)
app.thehammer.io/export/  → Export trigger (hammer-export-trigger)
```

---

### 2.3 CORS & Extension Origins

**Q: CORS allowed origin list?**
**A: Explicitly whitelist in `hammer-api` and `hammer-export-trigger`; never use `*`.**

```javascript
const allowedOrigins = [
  'https://app.thehammer.io',
  `chrome-extension://${process.env.EXTENSION_ID}`,
];
```

Store `EXTENSION_ID` in Secret Manager. Lock via CRX key — generate once with `openssl genrsa 2048`.

---

## 3. Identity & Access Management (IAM)

### 3.1 Service Account Architecture

**A: One dedicated SA per Cloud Run service, minimum-privilege.**

| SA Name | Assigned To | Roles |
|---|---|---|
| `hammer-api-sa` | `hammer-api` | `roles/datastore.user`, `roles/storage.objectCreator`, `roles/secretmanager.secretAccessor` |
| `hammer-portal-sa` | `hammer-portal` | `roles/storage.objectViewer` (portal assets bucket only) |
| `hammer-export-trigger-sa` | `hammer-export-trigger` | `roles/datastore.user`, `roles/run.developer` (to enqueue Jobs), `roles/secretmanager.secretAccessor` |
| `hammer-export-worker-sa` | `hammer-export-worker` Job | `roles/datastore.user`, `roles/storage.objectAdmin` (exports bucket only) |
| `hammer-cicd-sa` | GitHub Actions | `roles/run.developer`, `roles/artifactregistry.writer`, `roles/iam.serviceAccountUser` |

**Q: Workload Identity Federation for CI/CD?**
**A: Yes — mandatory.** One-time 20-minute setup. No JSON key files.

---

### 3.2 API Key Architecture

**Q: Secret Manager or Firestore `api_keys` collection?**
**A: Firestore `api_keys` collection.** Secret Manager is for static credentials, not a dynamic multi-user key store.

**Q: Hashed at rest?**
**A: Yes — SHA-256 of the raw key. Raw key shown once at issuance, never stored.**

```
Issuance: rawKey = crypto.randomBytes(32).toString('hex')
          keyHash = SHA-256(rawKey)
          Firestore: { keyHash, userId, role, createdAt, isActive: true }
          Return rawKey to admin UI ONCE

Middleware: hash incoming key → query api_keys by keyHash where isActive == true
```

**Q: Key rotation?**
**A: Automated quarterly via Cloud Scheduler + Cloud Function.** 7-day grace period, old key stays active until grace expires.

---

### 3.3 Admin Portal Authentication — Final Call 3A

**Final Call 3A — Cloud IAP identity token.**

Cloud IAP is placed in front of `hammer-portal` at the HTTPS Load Balancer level. The SPA and all its API calls use the IAP-injected identity token.

**How it works end-to-end:**

1. User hits `https://app.thehammer.io` — IAP intercepts, redirects to Google OAuth if no valid session
2. On success, IAP injects `X-Goog-Authenticated-User-Email` and `X-Goog-IAP-JWT-Assertion` headers into every request reaching `hammer-portal` and `hammer-api`
3. `hammer-api` reads `X-Goog-Authenticated-User-Email`, looks up the user's role in Firestore `users` collection, and applies role-based route guards
4. The SPA calls `hammer-api/api/*` routes using the IAP JWT (`X-Goog-IAP-JWT-Assertion`) as the Bearer token

**What this eliminates from Sprint 9:**
- Custom session management code
- Auth middleware for the portal's login/logout flow
- Firebase Auth dependency for the SPA
- Sprint 9.2 scope reduces from "implement auth middleware" to "read IAP header and check Firestore role"

**IAP does NOT protect the Chrome extension flow.** The extension continues to use the `X-Api-Key` header mechanism — IAP is for human browser sessions only.

```javascript
// hammer-api middleware — role check after IAP validates identity
async function requireRole(minRole) {
  return async (req, res, next) => {
    const email = req.headers['x-goog-authenticated-user-email']?.replace('accounts.google.com:', '');
    if (!email) return res.status(401).json({ error: 'IAP identity required' });
    const snap = await db.collection('users').where('email', '==', email).limit(1).get();
    if (snap.empty) return res.status(403).json({ error: 'User not provisioned' });
    const { role } = snap.docs[0].data();
    if (!ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[minRole]) return res.status(403).json({ error: 'Insufficient role' });
    req.user = { email, role, userId: snap.docs[0].id };
    next();
  };
}
```

**IAP setup checklist (pre-Sprint 5):**
- [ ] Enable IAP API: `gcloud services enable iap.googleapis.com`
- [ ] Create OAuth consent screen (internal, Google Workspace)
- [ ] Create OAuth 2.0 credentials for IAP
- [ ] Grant `roles/iap.httpsResourceAccessor` to each provisioned user's Google account
- [ ] Attach IAP to the HTTPS LB backend for `hammer-portal`
- [ ] Verify `X-Goog-Authenticated-User-Email` arrives in Cloud Run by checking Cloud Logging

---

## 4. Data & Firestore — Final Call 2A

### 4.1 Data Model — Flat Top-Level Collections

**Final Call 2A — Flat top-level collections with `projectId` field throughout.**

All collections are top-level. No subcollections under `projects/{id}/`. Every document that belongs to a project carries a `projectId` string field.

**Canonical collection list:**

| Collection | Key fields | Notes |
|---|---|---|
| `projects` | `id`, `name`, `adminId`, `createdAt` | One doc per project |
| `users` | `id`, `email`, `role`, `createdAt` | Role: `admin` \| `analyst` \| `instructional_designer` \| `user` |
| `project_memberships` | `projectId`, `userId`, `admittedAt`, `admittedBy` | Join table |
| `uploads` | `projectId`, `userId`, `tool`, `gcsPath`, `uploadedAt`, `sessionId` | Core capture record |
| `session_events` | `projectId`, `userId`, `sessionId`, `sessionStart`, `sessionEnd`, `firstCapturePath`, `lastCapturePath`, `deleteAfter` | TTL: +365 days |
| `inactivity_events` | `projectId`, `userId`, `sessionId`, `triggeredAt`, `resolvedAt`, `deleteAfter` | TTL: +365 days |
| `reports` | `projectId`, `analystId`, `type`, `status`, `gcsPath`, `generatedAt` | status: `pending`\|`processing`\|`done`\|`error` |
| `storyboards` | `projectId`, `designerId`, `slides[]`, `status`, `exportGcsPath`, `createdAt` | |
| `api_keys` | `keyHash`, `userId`, `role`, `createdAt`, `isActive`, `lastUsed` | SHA-256 hash only |

**Why flat over subcollections:**
- Cross-project admin queries (e.g., all `uploads` for a user across all projects) are simple `where('userId', '==', uid)` — no `collectionGroup` index required
- `COUNT()` aggregations work at the top level without `collectionGroup`
- Firestore security rules are easier to reason about with flat collections
- Sprint 7 analyst report queries (multi-project aggregations) do not require `collectionGroup` indexes

**Composite indexes required (check into `firestore.indexes.json`):**
```json
{
  "indexes": [
    { "collectionGroup": "uploads", "fields": [
      { "fieldPath": "projectId", "order": "ASCENDING" },
      { "fieldPath": "tool", "order": "ASCENDING" },
      { "fieldPath": "uploadedAt", "order": "DESCENDING" }
    ]},
    { "collectionGroup": "uploads", "fields": [
      { "fieldPath": "projectId", "order": "ASCENDING" },
      { "fieldPath": "userId", "order": "ASCENDING" },
      { "fieldPath": "uploadedAt", "order": "DESCENDING" }
    ]},
    { "collectionGroup": "session_events", "fields": [
      { "fieldPath": "projectId", "order": "ASCENDING" },
      { "fieldPath": "sessionStart", "order": "DESCENDING" }
    ]},
    { "collectionGroup": "reports", "fields": [
      { "fieldPath": "projectId", "order": "ASCENDING" },
      { "fieldPath": "generatedAt", "order": "DESCENDING" }
    ]},
    { "collectionGroup": "project_memberships", "fields": [
      { "fieldPath": "projectId", "order": "ASCENDING" },
      { "fieldPath": "admittedAt", "order": "DESCENDING" }
    ]}
  ]
}
```

**Q: Firestore transactions needed?**
**A: Yes — one case.** When admitting a user to a project, atomically write the `project_memberships` doc AND increment `project.memberCount`.

**Q: TTL fields?**
**A: `deleteAfter` on `session_events` and `inactivity_events` = `createdAt + 365 days`.** Enable Firestore TTL policy on this field. Zero-cost background deletion.

**Q: Firestore PITR?**
**A: Enable immediately.** `gcloud firestore databases update --database='(default)' --enable-pitr`. 7-day window. RPO: 1 hour.

---

## 5. Storage (GCS)

### 5.1 Bucket Architecture

**A: Four buckets with independent IAM, lifecycle rules, and CORS configs.**

| Bucket | Contents | Writer SA | Lifecycle |
|---|---|---|---|
| `hammer-screenshots-{PROJECT_ID}` | Extension captures | `hammer-api-sa` | Day 365 → NEARLINE; Day 730 → COLDLINE |
| `hammer-exports-{PROJECT_ID}` | FFmpeg MP4s | `hammer-export-worker-sa` | Day 30 → NEARLINE; Day 90 → delete |
| `hammer-reports-{PROJECT_ID}` | Analyst HTML/JSON | `hammer-api-sa` | Day 180 → NEARLINE |
| `hammer-backups-{PROJECT_ID}` | Firestore exports, log archives | Cloud Function SA | Day 30 → delete |

All buckets: `gsutil uniformbucketlevelaccess set on` — enforces IAM over ACLs, zero public objects.

**Signed URL lifetimes:**

| Use case | Lifetime |
|---|---|
| Screenshot thumbnails (Portal) | 15 min |
| Report HTML/JSON downloads | 60 min |
| MP4 video exports | 24 hours |
| Extension upload URLs (if ever added) | 5 min |

Use V4 signed URLs (SA credentials) throughout.

---

## 6. Observability & SRE

### 6.1 SLOs

| Service | SLI | SLO | Error budget (30 days) |
|---|---|---|---|
| `POST /api/capture` | % 2xx < 2 s | 99.5% availability; p99 < 2 s | 3.6 h |
| Report generation | % reaching `status: done` < 5 min | 95% | 5% failure |
| Video export | % completing < 15 min | 90% | 10% failure |
| Admin Portal | % page loads < 3 s | 99.0% | 7.2 h |

Create as Cloud Monitoring SLO objects. Burn-rate alert: page when 2× budget consumed in 1 hour.

### 6.2 Logging

Structured JSON via `pino`. All services write to stdout → Cloud Logging. Security log sink → `hammer-backups/logs/` for 1-year retention of 401/403, `data_access`, and `accessSecretVersion` calls.

Propagate `X-Cloud-Trace-Context` and `traceparent` across all four services.

### 6.3 Alert Set

| Alert | Condition | Severity |
|---|---|---|
| API 5xx rate | > 1% over 5 min | P1 |
| API p99 latency | > 3 s over 5 min | P2 |
| Report failure rate | > 10% in 10 min | P1 |
| Export job timeout | > 2 failures in 10 min | P2 |
| GCS 403 rate | > 10 in 5 min | P2 |
| Firestore quota | Daily reads > 80% quota | P3 |
| Secret Manager errors | Any `accessSecretVersion` error | P1 |
| Billing anomaly | Daily spend > 2× 30-day avg | P2 |

### 6.4 Runbook (minimum viable)

1. **Roll back Cloud Run revision:** `gcloud run services update-traffic hammer-api --to-revisions=PREV=100`
2. **Flush stuck export:** Query `status == 'processing' AND startedAt < now-30min` → set `status = 'failed'` → re-enqueue
3. **Revoke compromised API key:** `db.collection('api_keys').where('keyHash','==',hash).update({ isActive: false })`

---

## 7. CI/CD & Infrastructure as Code

### 7.1 GitHub Actions Pipeline

Two workflows replace `deploy.ps1`:
- `ci.yml` — on PR: lint, unit tests, integration tests against Firestore emulator
- `deploy.yml` — on merge to `main`: build → push to Artifact Registry → 10% canary → 15 min gate → 100% promote

All four services deployed independently. Tag images with Git SHA. Never `latest` in production.

### 7.2 Terraform IaC

Minimum coverage:
```
infra/
  cloud_run.tf       — all 4 services + Cloud Run Job
  gcs.tf             — 4 buckets + lifecycle + IAM
  firestore.tf       — PITR + backup schedule + TTL policies
  iam.tf             — 5 SAs + WIF pool
  secret_manager.tf  — secret names + rotation
  load_balancer.tf   — HTTPS LB + NEGs + Cloud Armor + IAP + cert
  monitoring.tf      — 8 alerts + 4 SLO objects
  dns.tf             — Cloud DNS zone
```

Two GCP projects: `hammer-dev` and `hammer-prod`. Terraform workspaces per environment.

---

## 8. Security & Compliance

- Secret scanning: run `run_secret_scanning` MCP tool on all source files; enforce in CI via `trufflesecurity/trufflehog-actions-scan`
- Secret Manager versioning: previous version disabled (not destroyed) 7 days after rotation
- Binary Authorization: enforce in `hammer-prod` — only CI-built images may deploy
- PII/GDPR: screenshots may capture PII. Document data classification policy before first user onboards. DPA with GCP required for EU users. Evaluate Cloud DLP scan before storage for Sprint 6S.
- Data residency: single-region Firestore (`us-central1`) and GCS buckets (`us-central1`) unless compliance requires otherwise

---

## 9. Chrome Extension

- Keep-alive: use `chrome.alarms` (not `setInterval`) for the 45-second inactivity timer — survives MV3 service worker suspension
- Session recovery: persist `{ sessionId, projectId, firstCapturePath, captureCount }` to `chrome.storage.session` on every capture; restore on `chrome.runtime.onStartup`
- Distribution: enterprise policy sideloading preferred for B2B; CRX key must be locked before Sprint 5 CORS config

---

## 10. Cost Model

**Estimated steady-state monthly cost (10 users, 20 captures/day/user):**

| Service | Est. cost/month |
|---|---|
| Cloud Run (4 services + Job) | $5–15 |
| Firestore (reads/writes at scale) | $2–5 |
| GCS storage (3 GB/month screenshots) | $0.06 |
| GCS egress (signed URL reads) | $1–3 |
| HTTPS LB + Cloud Armor | $20 |
| Cloud DNS | $1 |
| Secret Manager API calls | $0.03 |
| Cloud Logging (< 50 GB free) | $0 |
| **Total** | **~$30–45/month** |

Vision API / OCR (Sprint 6S) is the largest unknown cost driver. Benchmark before Sprint 6S ships. Set a GCP Billing budget alert at 3× the monthly estimate with auto-notify at 80% and 100%.
# The Hammer — Firestore Schema (Sprint 5, schemaVersion: 1)

> Architecture decision: **flat top-level collections** (Final Call 2A in `arch_decisions.md`).  
> Every cross-project document carries a `projectId` field. No subcollections. All new doc types include `schemaVersion: 1`.

---

## Collections

### `projects`

One document per project created by an admin.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Auto-generated Firestore doc ID |
| `name` | string | Display name, max 128 chars |
| `adminId` | string | `users` doc ID of creating admin |
| `memberCount` | number | Maintained by Firestore transaction on member add/remove |
| `createdAt` | string | ISO 8601 timestamp |
| `updatedAt` | string | ISO 8601 timestamp; set on every PATCH |
| `schemaVersion` | number | Always `1` |

**Example documents:**

```json
{
  "id": "proj_abc123",
  "name": "Acme Q3 GTM Audit",
  "adminId": "usr_zyx987",
  "memberCount": 3,
  "createdAt": "2026-06-16T14:00:00.000Z",
  "updatedAt": "2026-06-16T15:30:00.000Z",
  "schemaVersion": 1
}
```

```json
{
  "id": "proj_def456",
  "name": "Beta Launch Onboarding",
  "adminId": "usr_zyx987",
  "memberCount": 1,
  "createdAt": "2026-06-10T09:00:00.000Z",
  "updatedAt": "2026-06-10T09:00:00.000Z",
  "schemaVersion": 1
}
```

```json
{
  "id": "proj_ghi789",
  "name": "Enterprise Pilot — EMEA",
  "adminId": "usr_zyx987",
  "memberCount": 0,
  "createdAt": "2026-06-15T11:00:00.000Z",
  "updatedAt": "2026-06-15T11:00:00.000Z",
  "schemaVersion": 1
}
```

---

### `users`

One document per provisioned user (created by admin via portal).

| Field | Type | Notes |
|---|---|---|
| `id` | string | Auto-generated Firestore doc ID |
| `email` | string | Google account email (matches IAP `X-Goog-Authenticated-User-Email` sans prefix) |
| `role` | string | `admin` \| `analyst` \| `instructional_designer` \| `user` |
| `createdAt` | string | ISO 8601 timestamp |
| `createdBy` | string | `users` doc ID of admin who provisioned this user |
| `schemaVersion` | number | Always `1` |

**Example documents:**

```json
{
  "id": "usr_zyx987",
  "email": "alice@example.com",
  "role": "admin",
  "createdAt": "2026-06-01T08:00:00.000Z",
  "createdBy": "usr_zyx987",
  "schemaVersion": 1
}
```

```json
{
  "id": "usr_bob111",
  "email": "bob@example.com",
  "role": "analyst",
  "createdAt": "2026-06-10T10:00:00.000Z",
  "createdBy": "usr_zyx987",
  "schemaVersion": 1
}
```

```json
{
  "id": "usr_carol222",
  "email": "carol@example.com",
  "role": "user",
  "createdAt": "2026-06-12T14:00:00.000Z",
  "createdBy": "usr_zyx987",
  "schemaVersion": 1
}
```

---

### `project_memberships`

Join table between `projects` and `users`. Written atomically with `project.memberCount` increment (Firestore transaction, task 5.6).

| Field | Type | Notes |
|---|---|---|
| `id` | string | `{projectId}_{userId}` — deterministic, prevents duplicate membership |
| `projectId` | string | Foreign key to `projects` |
| `userId` | string | Foreign key to `users` |
| `role` | string | Role within this project (mirrors `users.role` at admission time; can diverge) |
| `admittedAt` | string | ISO 8601 timestamp |
| `admittedBy` | string | `users` doc ID of admin who ran `POST /admin/projects/:id/members` |
| `schemaVersion` | number | Always `1` |

**Example documents:**

```json
{
  "id": "proj_abc123_usr_bob111",
  "projectId": "proj_abc123",
  "userId": "usr_bob111",
  "role": "analyst",
  "admittedAt": "2026-06-16T14:05:00.000Z",
  "admittedBy": "usr_zyx987",
  "schemaVersion": 1
}
```

```json
{
  "id": "proj_abc123_usr_carol222",
  "projectId": "proj_abc123",
  "userId": "usr_carol222",
  "role": "user",
  "admittedAt": "2026-06-16T14:06:00.000Z",
  "admittedBy": "usr_zyx987",
  "schemaVersion": 1
}
```

```json
{
  "id": "proj_def456_usr_carol222",
  "projectId": "proj_def456",
  "userId": "usr_carol222",
  "role": "user",
  "admittedAt": "2026-06-16T15:00:00.000Z",
  "admittedBy": "usr_zyx987",
  "schemaVersion": 1
}
```

---

### `uploads` (existing — confirmed flat, no subcollections)

Core capture record written by `POST /capture`. Established in Sprint 4.  
`schemaVersion: 1` added to all new docs written from Sprint 5 onward (existing docs without it are grandfathered).

| Field | Type | Notes |
|---|---|---|
| `path` | string | GCS object path |
| `bucket` | string | GCS bucket name |
| `size` | number | File size in bytes |
| `projectId` | string | Foreign key to `projects` |
| `userId` | string | Foreign key to `users` |
| `tool` | string | Extension tool name (e.g. `"gtm"`, `"ga4"`) |
| `tabUrl` | string | Captured tab URL (max 500 chars) |
| `uploadedAt` | string | ISO 8601 timestamp |
| `sessionId` | string | Links to `session_events` doc (added Sprint 6) |
| `schemaVersion` | number | `1` on all docs written from Sprint 5 onward |

**Composite indexes** (declared in `infra/firestore.indexes.json`):
- `(projectId ASC, tool ASC, uploadedAt DESC)` — powers `GET /admin/projects/:id/activity?tool=`
- `(projectId ASC, userId ASC, uploadedAt DESC)` — powers Sprint 6 inactivity gap detection

---

## `firestore.indexes.json` location

`infra/firestore.indexes.json` — deployed via `firebase deploy --only firestore:indexes` in GitHub Actions.
# Time & Activity Tracking

This document defines how The Hammer measures time and activity for users, how those signals roll up into reporting metrics for Analysts and Admins, and what the user is told when they start using the extension.

The goal is to make the model:
- **Technically sound** — reflects what the browser and OS can realistically tell us.
- **Interpretable** — Analysts and Admins can trust and explain the numbers.
- **Transparent** — users clearly understand that screenshots are uploaded and time is being tracked.

---

## 1. Raw Signals

The system combines several low‑level signals:

1. **Session events (extension → `/session-events`)**
   - Written by the extension service worker via `sessionFlush()`.
   - Fields:
     - `sessionId` — UUID per browser session.
     - `projectId` — current project in the extension.
     - `sessionStart` — ISO string when the session started.
     - `sessionEnd` — ISO string when the session ended or was flushed.
     - `totalCaptures` — number of screenshots in this session.
     - `firstCapturePath` / `lastCapturePath` — GCS paths for first/last capture.
     - `schemaVersion` — currently `1`.
     - `deleteAfter` — `sessionStart + 365 days` (Firestore TTL).

2. **Uploads timeline (`uploads` collection)**
   - One document per uploaded screenshot.
   - Relevant fields:
     - `projectId`
     - `uploadedAt` — capture timestamp.
     - `sessionId` (optional, but recommended) — to correlate with `session_events`.
     - `tool`, `stage`, and other capture metadata.

3. **Inactivity events (extension → `/inactivity-events`)**
   - Emitted when the inactivity timer fires while the user has the feature enabled.
   - Fields:
     - `triggeredAt` — ISO timestamp when the prompt was raised.
     - `userId` — resolved server‑side from API key.
     - `projectId`
     - `acknowledged` — `true` if the user clicked **Capture Now** or **Snooze**.
     - `inactiveDurationMs` (optional) — duration of that idle stretch, if available.
     - `schemaVersion` — currently `1`.
     - `deleteAfter` — `triggeredAt + 365 days` (Firestore TTL).

4. **Idle / focus signals (optional enhancements)**
   - **Chrome Idle API** (`chrome.idle`) — reports `active` vs `idle` vs `locked` for the device.
   - **Tab/window focus** (Chrome tabs & windows APIs) — track when the Hammer tab is the active tab in a focused Chrome window.
   - **Page visibility & focus** (`document.visibilityState`, `document.hasFocus()`) — track when the page is visible and focused in the browser.

The first three are mandatory and already wired into Sprints 6 and 7. Idle/focus signals are optional layers to refine calculations without changing reports’ public contract.

---

## 2. Core Time Metrics

All metrics are computed on the backend (not in the extension) from the signals above.

### 2.1 Session duration

Per `session_events` document:

- `sessionDurationMs = sessionEnd - sessionStart`
- `sessionDurationMinutes = sessionDurationMs / 60_000`

This is **wall‑clock** session length for the Hammer extension in that browser profile.

### 2.2 Inactive time in session

Two compatible strategies are supported.

#### A. Event‑based (preferred when `inactiveDurationMs` is populated)

For a given session `S`:

- Collect all `inactivity_events` where `sessionId == S.sessionId`.
- For each event with `inactiveDurationMs`:
  - `inactiveTimeInSessionMs += inactiveDurationMs`

This yields total idle time in that session based on the timer and user acknowledgement behavior.

#### B. Gap‑based (fallback / cross‑check)

For a given session `S`:

- Fetch all `uploads` where `sessionId == S.sessionId` ordered by `uploadedAt`.
- For each adjacent pair of captures `(t_i, t_{i+1})`:
  - `gap = t_{i+1} - t_i`
  - If `gap > inactivityThresholdMs` (e.g., 45_000):
    - `inactiveTimeInSessionMs += (gap - inactivityThresholdMs)`

This treats the first 45 seconds of any gap as potentially “still working between captures,” and only counts the excess as inactive.

### 2.3 True active time (session‑level)

Per session `S`:

- `trueActiveMs = sessionDurationMs - inactiveTimeInSessionMs`
- `trueActiveMinutes = trueActiveMs / 60_000`

This is the primary metric we use to represent “time the user was likely working in a Hammer session.” It is **session‑scoped**, not page‑scoped, and includes short periods where the user may be copying from other tools into the Hammer project.

### 2.4 Focus‑constrained active time (optional secondary metric)

If idle/focus signals are implemented, we can derive a stricter metric:

- `focusedAndActiveMs` — intersection of:
  - device **active** (Chrome Idle API: `state == 'active'`), and
  - Hammer tab **focused & visible** (tabs/windows + Visibility API), and
  - within the session window `[sessionStart, sessionEnd]`.

Then:

- `focusedActiveMinutes = focusedAndActiveMs / 60_000`

This gives a conservative lower bound on “time actually looking at a Hammer tab,” which is helpful for forensic/diagnostic use but may undercount valid work (e.g., time spent in a spreadsheet copying values into Hammer).

---

## 3. Report‑Level Metrics (Analyst & Admin)

The following metrics are made visible to both Analysts and Admins in the **User Efficiency** report (Sprint 7.5) and selected Admin Portal views.

### 3.1 User Efficiency report (Sprint 7.5)

For a given user, project, and date range:

- **Total sessions** — count of `session_events` in range.
- **Total session time (minutes)** — sum of `sessionDurationMinutes`.
- **True active time (minutes)** — sum of `trueActiveMinutes` across sessions.
- **Inactive time (minutes)** — `Total session time - True active time`.
- **Active ratio** — `True active time / Total session time`.
- **Captures per active hour** — `Total captures / (True active time in hours)`.
- **Optionally:** Focused active time (if implemented) — `focusedActiveMinutes`, with the caveat that this is a stricter measure.

All of these are rolled up per user and per project, and can be filtered by date range. Analysts see them in the JSON & HTML report; Admins see the same metrics rendered in the Portal’s report viewer.

### 3.2 Admin Portal surfaces

- **Activity timeline (Sprint 6.11):**
  - Uses `uploads` + `session_events` to highlight gaps > 45 seconds in amber.
  - Hovering a gap can display the estimated inactive duration for added context.

- **Per‑user panel:**
  - Shows, for a selected period (e.g., last 7 or 30 days):
    - `Total session time`.
    - `True active time`.
    - `Active ratio`.

- **Dashboard (Sprint 9.15):**
  - May surface:
    - “Active users today” — users whose `trueActiveMinutes` exceeds a configurable threshold.
    - Aggregate `True active time` per project.

Analyst and Admin views are intentionally aligned so they can speak about the same metrics without translation.

---

## 4. Entitlements & Feature Flags

Not all users will have inactivity prompts turned on. To keep behavior predictable and auditable:

- A per‑user entitlement flag (e.g., `inactivityPromptEnabled`) is stored in Firestore (on `users` or `api_keys`).
- The extension only schedules `chrome.alarms` and emits `/inactivity-events` **when this flag is true**.
- True active time is computed for all users, but inactivity‑event–based calculations are more accurate when the flag is enabled.

This aligns with the broader feature‑entitlement pattern used for Blur, Clipboard Links, and other admin‑gated capabilities.

---

## 5. User‑Facing Disclosure & Consent

To keep tracking compliant and transparent, the extension presents a clear prompt when a user first starts using The Hammer (or when this behavior is materially changed).

### 5.1 When the prompt appears

- On first run after installation, **or**
- After an update that introduces time tracking or inactivity prompts, **or**
- When an admin newly enables inactivity tracking for that user.

Until the user acknowledges the prompt, the extension operates in a restricted mode (e.g., captures disabled or clearly labeled as “not yet tracking”) to avoid implicit consent.

### 5.2 Prompt content (conceptual)

The copy should be adapted to your org’s legal and policy language, but structurally it includes:

1. **What is collected**
   - Screenshots you explicitly capture using The Hammer.
   - Metadata about those captures (time, project, tool/stage).
   - Session timing: when your capture sessions start & end, and periods where you appear inactive.

2. **How it is used**
   - To help your team understand project progress and tool usage.
   - To generate efficiency and inactivity reports for Admins and Analysts.

3. **Where it is stored and for how long**
   - Stored in your organization’s Hammer environment (Firestore + GCS).
   - Screenshots and time‑tracking events are automatically deleted according to documented retention policies (e.g., session/inactivity events after 1 year).

4. **Your controls**
   - You can see which project a capture is associated with in the extension.
   - Inactivity prompts may be turned on or off for you by an Admin.

5. **Explicit consent action**
   - A clear call to action, such as:
     - **[I understand and agree]**
     - Optional **[More details]** link to internal policy / documentation.

Once accepted, the extension records acceptance locally (and optionally in Firestore) so future sessions don’t re‑prompt unless behavior changes materially.

---

## 6. Implementation Notes

- **Backwards compatibility:** If `inactiveDurationMs` is not populated (older clients), the gap‑based method remains valid and continues to feed true active time.
- **Performance:** Time‑aggregation queries are performed on the backend (e.g., Cloud Run worker) and materialized into report documents; the portal and extension never perform heavy aggregations client‑side.
- **Privacy:** All timing data is scoped by `projectId` and subject to the same data classification and retention policies as screenshots. Admins should ensure this document stays aligned with `data-classification.md` and any formal DPA.
