# The Hammer — Production Architecture Decisions
## Senior GCP Architect & SRE Recommendations

_Optimal answers to every open question in `arch_questions.md`, scoped to a small-team B2B SaaS product on GCP (Cloud Run · Firestore · GCS · Secret Manager). Recommendations balance production correctness with implementation velocity._

---

## 1. Compute & Cloud Run

### 1.1 Service Topology

**Q: How many Cloud Run services?**
**A: Three separate services + one Cloud Run Job.**

| Service | Purpose | `--min-instances` | `--max-instances` | Concurrency |
|---|---|---|---|---|
| `hammer-api` | Capture ingest, admin CRUD, auth middleware | 1 | 20 | 80 (default) |
| `hammer-portal` | Admin/Analyst/ID SPA (static files via Nginx) | 0 | 5 | 80 |
| `hammer-export` | FFmpeg Cloud Run **Job** (not a Service) | N/A | N/A | 1 |

Keep `hammer-api` and `hammer-portal` separate so the portal can be scaled and deployed independently. The portal serves static HTML/CSS/JS with zero CPU cost between requests — do not tie it to the API's min-instances cost.

**Q: Cloud Run Job or Service for FFmpeg?**
**A: Cloud Run Job.**

FFmpeg renders are discrete, bounded tasks — not long-running servers. Cloud Run Jobs are purpose-built for this: no HTTP server required, billed only for execution time, and each job execution maps cleanly to one storyboard export. Use Cloud Tasks to enqueue job executions. Set `--task-timeout 1800s` with a hard 50-slide ceiling enforced in the Job before FFmpeg starts.

**Q: Maximum request timeout?**
**A:** `hammer-api` → 300 s; `hammer-portal` → 60 s; export Job → 1800 s.

The API's longest synchronous operation is Firestore aggregation for report generation. 300 s is generous. FFmpeg at 50 slides × 3 s/slide = 150 s render + encode overhead, capped at 1800 s.

**Q: HTTP/2 or gRPC?**
**A: REST over HTTPS is sufficient.** No inter-service streaming exists. For real-time dashboard updates, use Firestore `onSnapshot` listeners from the browser — not a gRPC service.

---

### 1.2 Scaling & Traffic

**Q: Expected concurrent users?**
**A: Assume 5–20 steady state, 50 at peak for a small B2B deployment.** Set `--max-instances 20` on `hammer-api`; adjust after 30 days of production metrics. Cloud Run scales to zero when idle — max-instances is a cost ceiling, not a floor.

**Q: Concurrency per instance?**
**A:** `hammer-api`: 80 (default; Node.js event loop handles it). `hammer-portal`: 80 (static serving). `hammer-export` Job: **1** (FFmpeg is CPU-bound; one render per instance).

**Q: Serverless VPC Access connector?**
**A: No, unless compliance requires it.** Firestore and GCS are accessed via Google's public APIs over TLS. Add a VPC connector only if you later need to reach Cloud SQL or a private VM.

**Q: Domain mapping?**
**A: Custom domain via Global HTTPS Load Balancer + Google-managed SSL cert.** Do not use Cloud Run's built-in domain mapping — it is a legacy feature with limited routing capabilities.

---

## 2. Networking & Ingress

### 2.1 Load Balancing

**Q: CLB or direct Cloud Run URLs?**
**A: Global HTTPS Load Balancer with Serverless NEGs.** Non-negotiable for production. Provides: single IP for custom domain DNS, Google-managed SSL cert (auto-renewed), Cloud Armor WAF, path-based routing, and CDN for portal static assets.

```
LB Frontend: HTTPS :443 → URL Map
  /api/*  → Backend: hammer-api  (Serverless NEG, us-central1)
  /*      → Backend: hammer-portal (Serverless NEG, us-central1)
```

**Q: Cloud Armor?**
**A: Yes — add a basic Cloud Armor policy on Day 1.** Cost: $5/month + $0.75/million requests. Minimum rules:
1. Preconfigured rule: `sqli-stable`
2. Preconfigured rule: `xss-stable`
3. Rate limit: 100 requests/minute per IP (protects against credential stuffing)
4. Geo-block: optional, only if known non-user regions exist

This is not optional for a platform storing customer GTM/GA4 configs.

---

### 2.2 DNS & TLS

**Q: DNS provider?**
**A: Cloud DNS as the authoritative nameserver.** Integrates natively with Certificate Manager and Cloud Armor. Cost: $0.20/zone/month.

**Q: SSL certs?**
**A: Google-managed certificates via Certificate Manager** (not legacy `compute ssl-certificates`). Attach to the HTTPS LB frontend. Auto-renewed — zero maintenance. Do not use Let's Encrypt/Certbot on Cloud Run; there is no persistent filesystem.

**Q: Subdomain topology?**
**A: Path-routing under one domain.** Single domain = single LB = single cert = simpler CORS config.

```
app.thehammer.io/       → Admin Portal SPA (hammer-portal)
app.thehammer.io/api/   → REST API (hammer-api)
```

---

### 2.3 CORS & Extension Origins

**Q: CORS allowed origin list?**
**A: Explicitly whitelist in `hammer-api`; never use `*`.**

```javascript
const allowedOrigins = [
  'https://app.thehammer.io',
  `chrome-extension://${process.env.EXTENSION_ID}`,
];
```

Store `EXTENSION_ID` in Secret Manager.

**Q: Stable extension ID?**
**A: Yes — lock via CRX key.** Generate once with `openssl genrsa 2048`. Store the private key in Secret Manager (never in the repo). The `key` field in `manifest.json` locks the unpacked ID; the same key used at Web Store publish locks the production ID. This is a one-time setup step that must happen before Sprint 5 CORS is configured.

---

## 3. Identity & Access Management (IAM)

### 3.1 Service Account Architecture

**A: One dedicated SA per Cloud Run service, minimum-privilege.**

| SA Name | Assigned To | Roles |
|---|---|---|
| `hammer-api-sa` | `hammer-api` | `roles/datastore.user`, `roles/storage.objectCreator`, `roles/secretmanager.secretAccessor` |
| `hammer-portal-sa` | `hammer-portal` | `roles/storage.objectViewer` (portal assets bucket only) |
| `hammer-export-sa` | `hammer-export` Job | `roles/datastore.user`, `roles/storage.objectAdmin` (exports bucket only), `roles/secretmanager.secretAccessor` |
| `hammer-cicd-sa` | GitHub Actions / Cloud Build | `roles/run.developer`, `roles/artifactregistry.writer`, `roles/iam.serviceAccountUser` |

Never grant `roles/owner` or `roles/editor` to any SA. `roles/datastore.user` (not `datastore.admin`) is sufficient for all runtime read/write operations.

**Q: Workload Identity Federation for CI/CD?**
**A: Yes — mandatory.** Configure GitHub Actions with WIF so the CI pipeline authenticates as `hammer-cicd-sa` without a JSON key file. Eliminates the most common source of leaked GCP credentials. One-time 20-minute setup.

```yaml
# .github/workflows/deploy.yml (partial)
- uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: 'projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/providers/github-provider'
    service_account: 'hammer-cicd-sa@PROJECT_ID.iam.gserviceaccount.com'
```

---

### 3.2 API Key Architecture

**Q: Secret Manager or Firestore `api_keys` collection?**
**A: Firestore `api_keys` collection.** Secret Manager is designed for static credentials, not a dynamic multi-user key store. Firestore provides per-key metadata (userId, role, createdAt, lastUsed, isActive), fast lookup by hash, atomic revocation, and an audit trail. Secret Manager at 60 API req/min would cost ~$2,600/month in API call fees alone.

**Q: Hashed at rest?**
**A: Yes — SHA-256 of the raw key stored in Firestore. The raw key is shown exactly once at issuance and never stored.**

```
Issuance flow:
1. Admin clicks "Generate Key" in portal
2. Backend: rawKey = crypto.randomBytes(32).toString('hex')
3. keyHash = SHA-256(rawKey)
4. Write { keyHash, userId, role, createdAt, isActive: true } to Firestore api_keys
5. Return rawKey to admin UI ONCE — never stored server-side

Middleware on every request:
const keyHash = sha256(req.headers['x-api-key']);
const doc = await db.collection('api_keys')
  .where('keyHash', '==', keyHash)
  .where('isActive', '==', true)
  .limit(1).get();
if (doc.empty) return res.status(401).json({ error: 'Invalid key' });
```

**Q: Key rotation policy?**
**A: Automated quarterly rotation via Cloud Scheduler + Cloud Function.** The function generates a new key per active user, writes it to a `pending_rotations` collection, emails the new key, and sets `gracePeriodEnds = now + 7 days`. Old key stays `isActive: true` until grace period expires. A daily cleanup function sets `isActive: false` on expired keys.

**Q: Key issuance workflow?**
**A: Admin-issued only** (not self-serve) at current scale. Admin generates a key per user in the portal; displayed once and must be copied immediately.

---

### 3.3 Admin Portal Authentication

**Q: Firebase Auth, Google SSO, or Cloud IAP?**
**A: Cloud IAP (Identity-Aware Proxy) in front of `hammer-portal`.** The correct choice for B2B internal tooling:

- Zero authentication code to write — IAP handles the full Google OAuth flow
- Authenticates with the user's Google Workspace account
- Applied as middleware on the HTTPS LB; the portal SPA never receives unauthenticated requests
- `hammer-api` reads the `X-Goog-Authenticated-User-Email` header IAP injects for role checks
- Cost: free for Cloud Run + IAP combination

> **Sprint 5 impact:** Task 5.13 scope reduces from "implement auth middleware" to "read IAP-injected header and check role." The API's `X-Api-Key` middleware remains for programmatic extension calls.

---

## 4. Data & Firestore

### 4.1 Data Model

**Q: Schema migration strategy?**
**A: Additive-only changes + a `schemaVersion` field on documents.** Never rename or delete fields in production — add new fields alongside old ones, then deprecate after all reads have migrated. Write migration Cloud Functions for any field renames. Track all changes in `firestore-schema-changelog.md`.

**Q: Flat `uploads` collection vs subcollection under `projects/`?**
**A: Flat `uploads` collection with a `projectId` field.** Subcollections complicate cross-project queries (require `collectionGroup` with additional indexes) and cannot be counted at the top level without `collectionGroup`. Flat collections with `projectId` + `userId` fields support all current query patterns with standard composite indexes.

**Q: Expected document volume at 12 months?**
**A:** 10 projects × 5 users × 20 captures/day × 365 days = ~365,000 `uploads` docs ≈ 180 MB. Well within Firestore's 1 GB free tier. GCS is the cost driver, not Firestore storage.

**Q: Firestore transactions needed?**
**A: Yes — one case.** When admitting a user to a project, atomically write the `project_memberships` doc AND increment `project.memberCount`. Use a Firestore transaction. All other operations are single-document writes.

---

### 4.2 Querying & Indexes

**Q: Composite indexes in `firestore.indexes.json`?**
**A: Yes — all indexes declared in source control and deployed via CI.**

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
    ]}
  ]
}
```

**Q: Aggregation queries or client-side counting?**
**A: Firestore `count()` aggregation queries** (GA since 2023) for all dashboard metrics. Do not read full collections and count client-side — at 365K docs that costs $0.365 per dashboard load. `count()` queries cost $0.001 each.

**Q: Firestore mode?**
**A: Native mode — verify immediately.** Run `gcloud firestore databases describe` and confirm `type: FIRESTORE_NATIVE`. If it shows `DATASTORE_MODE`, you must create a new GCP project — this cannot be changed post-creation.

---

### 4.3 Backup & Recovery

**Q: Firestore PITR?**
**A: Enable with 7-day retention window.** Cost: ~$0.10/GB/month. For a 180 MB database: negligible. Command: `gcloud firestore databases update --database='(default)' --enable-pitr`. Target RPO: 1 hour.

**Q: Scheduled export to GCS?**
**A: Daily export via Cloud Scheduler → Pub/Sub → Cloud Function.**

```
Cloud Scheduler (02:00 UTC daily) → Pub/Sub → Cloud Function →
  firestoreAdmin.exportDocuments({ outputUriPrefix: 'gs://hammer-backups-{PROJECT_ID}/firestore/{YYYY-MM-DD}/' })
```

Retain 30 days of exports. Enables future BigQuery ingestion.

**Q: Firestore TTL for time-series docs?**
**A: Yes — add `deleteAfter` timestamp to `session_events` and `inactivity_events`.** Set `deleteAfter = createdAt + 365 days`. Enable Firestore TTL policy on this field. Zero-cost background deletion — no Cloud Function needed. `uploads` documents are retained indefinitely (they are the core product record).

---

## 5. Storage (GCS)

### 5.1 Bucket Architecture

**Q: How many buckets?**
**A: Four buckets with independent IAM, lifecycle rules, and CORS configs.**

| Bucket | Contents | Writer | Reader | Lifecycle |
|---|---|---|---|---|
| `hammer-screenshots-{PROJECT_ID}` | Extension PNG/WebP captures | `hammer-api-sa` | `hammer-api-sa`, `hammer-export-sa` | Day 365 → NEARLINE; Day 730 → COLDLINE |
| `hammer-exports-{PROJECT_ID}` | FFmpeg MP4s | `hammer-export-sa` | `hammer-api-sa` (signed URLs) | Day 30 → NEARLINE; Day 90 → delete |
| `hammer-reports-{PROJECT_ID}` | Analyst HTML/JSON | `hammer-api-sa` | `hammer-api-sa`, `hammer-portal-sa` | Day 180 → NEARLINE |
| `hammer-backups-{PROJECT_ID}` | Firestore exports, log archives | Cloud Function SA | `hammer-cicd-sa` only | Day 30 → delete |

Add `{PROJECT_ID}` suffix — GCS bucket names are globally unique.

**Q: Storage class transitions?**
**A: As per lifecycle table above.** NEARLINE at $0.01/GB/month vs STANDARD at $0.02. COLDLINE at $0.004/GB/month for archival. Use tiered transitions rather than straight deletion — data should be cheaply accessible before it expires.

---

### 5.2 Access Patterns

**Q: All signed URLs, no public objects?**
**A: Correct — zero public objects.** Enforce immediately: `gsutil uniformbucketlevelaccess set on gs://BUCKET` on all four buckets. This also enforces IAM over ACLs, which is required for the SA-based access model above.

**Q: Signed URL lifetime strategy?**

| Use case | Lifetime | Rationale |
|---|---|---|
| Screenshot thumbnails (Admin Portal) | 15 minutes | Short; refreshed on `visibilitychange` |
| Report HTML/JSON downloads | 60 minutes | One-time download; longer window acceptable |
| MP4 video exports | 24 hours | Large file; user may need multiple download attempts |
| Extension upload URLs | 5 minutes | Upload starts immediately; short window limits blast radius |

Use **V4 signed URLs** (service account credentials) — more secure than V2 (HMAC keys).

**Q: Extension writes directly to GCS or via Cloud Run?**
**A: Extension POSTs to `hammer-api`, which writes to GCS.** Keep this pattern. The API validates screenshot file type, size limit, and project membership before writing. Direct GCS writes would require issuing upload-scoped signed URLs to the extension, expanding the trust boundary unnecessarily. The ~50–100 ms overhead is acceptable for a screenshot capture workflow.

---

### 5.3 Screenshot Quality & Size

**Q: Expected file size?**
**A: 200–800 KB/screenshot for full-HD PNG; 80–300 KB for WebP at quality 85.** Cost model: 10 users × 20 captures/day × 500 KB average = 100 MB/day = ~3 GB/month ≈ $0.06/month in STANDARD storage. Negligible.

**Q: PNG or WebP?**
**A: WebP for storage, PNG fallback.** Chrome's `captureVisibleTab` can return WebP via `canvas.toBlob('image/webp', 0.9)`. For OCR screenshots (Sprint 6S), evaluate whether WebP quality 90+ preserves text legibility — if not, use lossless WebP (`quality: 1.0`) for GTM/GA4 dashboard screenshots specifically.

---

## 6. Observability & SRE

### 6.1 SLIs and SLOs

**A: Adopt these SLOs. Review after 90 days of production data.**

| Service | SLI | SLO | 30-day error budget |
|---|---|---|---|
| Capture endpoint (`POST /capture`) | % requests completing < 2 s with 2xx | 99.5% availability; p99 < 2 s | 3.6 h downtime; 21.6 min latency budget |
| Report generation | % of reports reaching `status: done` within 5 min | 95% within 5 min | 5% failure rate |
| Video export | % of jobs completing within 15 min | 90% within 15 min | 10% failure/timeout rate |
| Admin Portal | % of page loads < 3 s | 99.0% availability | 7.2 h downtime |

Create these as **Cloud Monitoring SLO objects** (not just alert policies). Cloud Monitoring tracks error budget burn rate automatically and alerts when burn rate exceeds 2× the budget in 1 hour.

---

### 6.2 Logging

**Q: Structured JSON logs?**
**A: Yes — implement from day one using `pino` in Node.js.**

```javascript
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
// Per-request log:
logger.info({
  requestId: req.headers['x-request-id'],
  userId, projectId,
  method: req.method, path: req.path,
  statusCode: res.statusCode, durationMs
}, 'request completed');
```

Cloud Run writes stdout JSON directly to Cloud Logging with automatic field parsing.

**Q: Log retention policy?**
**A:**
- `_Default` bucket: 30 days (default — sufficient for debugging)
- Create a `_Security` log sink → GCS `hammer-backups/logs/` with 1-year retention for: all 401/403 events, `cloudaudit.googleapis.com/data_access`, and Secret Manager `accessSecretVersion` calls
- Cloud Logging first 50 GB/month is free; at ~500 MB/day this platform stays in free tier indefinitely

**Q: Trace IDs across services?**
**A: Yes — propagate `X-Cloud-Trace-Context` and `traceparent` headers.** Cloud Run auto-propagates `X-Cloud-Trace-Context` between services when forwarded. Add middleware to `hammer-api` to forward the trace header to all outgoing Cloud Tasks enqueues. Use `@google-cloud/trace-agent` for automatic instrumentation.

---

### 6.3 Complete Alert Set

**A: Replace the current 2 alerts with these 8.**

| Alert | Condition | Severity | Notify |
|---|---|---|---|
| API 5xx error rate | `hammer-api` 5xx > 1% over 5 min | P1 | Slack `#hammer-alerts` + email |
| API p99 latency | `hammer-api` p99 > 3 s over 5 min | P2 | Email |
| Report failure rate | > 10% of reports reach `status: error` in 10 min | P1 | Slack + email |
| Export job timeout | > 2 export jobs fail/timeout in 10 min | P2 | Email |
| GCS 403 rate | > 10 GCS 403 responses in 5 min | P2 | Email |
| Firestore quota | Daily reads > 80% of quota | P3 | Email |
| Secret Manager failures | `accessSecretVersion` error rate > 0 | P1 | Slack + email |
| Billing anomaly | Daily spend > 2× 30-day average | P2 | Email |

---

### 6.4 Error Budget & Deployment

**Q: Incident runbook?**
**A: Add `runbook.md` to the repo with these three minimum procedures.**

1. **Roll back a Cloud Run revision:**
   ```
   gcloud run services update-traffic hammer-api --to-revisions=PREV_REVISION=100 --region=us-central1
   ```

2. **Flush a stuck export job:** Query Firestore for docs where `status == 'processing'` AND `startedAt < now - 30 min`. Update `status = 'failed'`. Re-enqueue via `POST /export/video` with the same `storyboardId`.

3. **Revoke a compromised API key immediately:**
   ```javascript
   await db.collection('api_keys')
     .where('keyHash', '==', compromisedHash)
     .get()
     .then(snap => snap.docs[0].ref.update({ isActive: false, revokedAt: Timestamp.now(), revokedReason: 'compromised' }));
   ```
   Takes effect on the next API request — no cache to invalidate.

**Q: Canary deployments?**
**A: Yes — use Cloud Run traffic splitting for all API deploys.** Pattern: deploy new revision → split 10% for 15 min → monitor Cloud Monitoring SLO burn rate → if clean, shift to 100%.

```
gcloud run services update-traffic hammer-api --to-revisions=NEW_REV=10,OLD_REV=90 --region=us-central1
# Wait 15 min — check SLO dashboard
gcloud run services update-traffic hammer-api --to-revisions=NEW_REV=100 --region=us-central1
```

Automate this 15-minute gate in the GitHub Actions deploy workflow.

---

## 7. CI/CD & Infrastructure as Code

### 7.1 Pipeline

**Q: Replace `deploy.ps1` with what?**
**A: GitHub Actions with two workflows.**

```
.github/workflows/
  ci.yml      → on: pull_request → lint, unit tests, integration tests (mock GCP services)
  deploy.yml  → on: push to main → build Docker image, push to Artifact Registry,
                                    deploy to Cloud Run (10% canary), wait 15 min, promote to 100%
```

`deploy.ps1` becomes a local helper for one-off GCP resource creation only, never for production service deploys.

**Q: Container Registry or Artifact Registry?**
**A: Artifact Registry.** Container Registry is deprecated. Create one Docker repository per GCP project:
```
us-central1-docker.pkg.dev/{PROJECT_ID}/hammer/
```
Tag images with the Git SHA: `hammer-api:abc1234`. Never use `latest` in production.

---

### 7.2 Infrastructure as Code

**Q: Terraform, Pulumi, or imperative gcloud?**
**A: Terraform with the `hashicorp/google` provider.** Larger community, broader GCP resource coverage, and `terraform plan` output is readable in PR reviews by non-engineers.

Minimum IaC coverage (added to Sprint 9 or a dedicated infra task):
```
infra/
  main.tf              → provider config, GCP project references
  cloud_run.tf         → all 3 services + Cloud Run Job definitions
  gcs.tf               → all 4 buckets + lifecycle rules + uniform bucket-level access + IAM bindings
  firestore.tf         → database PITR config + backup schedule + TTL policies
  iam.tf               → all 4 SAs + role bindings + Workload Identity Pool
  secret_manager.tf    → secret resource names + rotation schedules (not secret values)
  load_balancer.tf     → Global HTTPS LB + serverless NEGs + Cloud Armor policy + SSL cert
  monitoring.tf        → all 8 alert policies + notification channels + 4 SLO objects
  dns.tf               → Cloud DNS zone + A records
```

**Q: Separate GCP projects for dev/prod?**
**A: Two projects minimum: `hammer-dev` and `hammer-prod`.** Use Terraform workspaces to deploy the same config to both. A broken Firestore index rebuild or misconfigured IAM binding in `hammer-dev` cannot reach `hammer-prod`.

**Q: Environment-specific config?**
**A: Separate Secret Manager secrets per project.** Each GCP project has its own Secret Manager instance. Use Terraform variable files (`terraform.tfvars.dev`, `terraform.tfvars.prod`). Never `.env` files committed to the repo.

---

## 8. Security & Compliance

### 8.1 Secrets Management

**Q: Secret scanning on the repo?**
**A: Run immediately, then enforce in CI.**

```yaml
# .github/workflows/ci.yml
- name: Scan for secrets
  uses: gitleaks/gitleaks-action@v2
```

Also enable GitHub's native Secret Scanning on the repository settings page. This retroactively scans all commits and alerts on newly pushed secrets automatically.

**Q: Secret Manager versioning on rotation?**
**A: Keep previous version enabled for 7 days (grace period), disable after, destroy after 90 days.** Never destroy immediately — destroyed secret versions are unrecoverable and may break services that cached the previous value during a deploy.

**Q: Audit log review?**
**A: Create a Cloud Monitoring log-based metric on `accessSecretVersion` calls.** Alert (P1, Slack) when a secret is accessed from an unexpected service account. Route all `data_access` audit logs to the GCS backup sink for 1-year retention.

---

### 8.2 Data Privacy

**Q: PII data classification policy?**
**A: Classify screenshots as `CONFIDENTIAL`. Document in `data-classification.md`.**

| Data Type | Classification | Retention | Access |
|---|---|---|---|
| Screenshots | Confidential | 365d STANDARD → 730d COLD | Project members via signed URLs only |
| Session events | Internal | 365d then TTL-deleted | Admin + Analyst roles |
| Reports | Internal | 180d | Analyst + Admin roles |
| API keys | Secret | Until revoked | Admin only; SHA-256 hash at rest |

**Q: GDPR DPA?**
**A: GCP's Data Processing Addendum is included in the Google Cloud Terms of Service.** Ensure your own customer-facing DPA is in place before onboarding EU users. Add to backlog: "legal review of DPA before EU onboarding."

**Q: Data residency?**
**A: Single-region `us-central1` for Firestore and all GCS buckets.** Multi-region adds ~2× storage cost with no performance benefit for a single-region team. If EU users are added, create a separate `hammer-eu` GCP project in `europe-west1`.

**Q: Cloud DLP for PII scanning?**
**A: Defer to post-MVP.** Cost: $1/GB inspected = ~$3/month at current volume. The integration work (async inspection pipeline, quarantine bucket, notification system) is a full sprint. Add to backlog with trigger: "implement Cloud DLP before platform exceeds 50 users or before any EU onboarding."

---

### 8.3 Network Security

**Q: Private Google Access?**
**A: Not required without a VPC.** Cloud Run on the public internet accesses GCS and Firestore via Google's public APIs over TLS. Standard and secure for this architecture. Add VPC + Private Google Access only if Cloud SQL or a private VM is introduced.

**Q: Internal ingress on non-public services?**
**A: Yes.** Set `hammer-export` Cloud Run Job to `--ingress internal-and-cloud-load-balancing` — triggered only by Cloud Tasks (internal GCP call), never external HTTP. `hammer-api` and `hammer-portal` remain `--ingress all` to serve external LB traffic.

**Q: Binary Authorization?**
**A: Implement in Sprint 9.** Policy: only images built and signed by `hammer-cicd-sa` via Cloud Build can be deployed to Cloud Run. Prevents "deploy from laptop" bypassing CI. ~2 hours to configure; add to `infra/cloud_run.tf`.

---

## 9. Chrome Extension

### 9.1 MV3 Service Worker Lifecycle

**Q: Keep-alive strategy?**
**A: Persistent `chrome.runtime.connect` port from the popup + `chrome.storage.session` for in-flight state.**

```javascript
// Service worker: keep alive while popup port is open
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    // Port reference prevents SW termination while popup is open
    port.onDisconnect.addListener(() => { /* SW may now sleep */ });
  }
});

// Persist session state across SW restarts
await chrome.storage.session.set({ sessionId, firstCapturePath, captureCount });

// On SW startup: restore in-progress session
const { sessionId } = await chrome.storage.session.get('sessionId');
if (sessionId) { /* resume session, do not create new */ }
```

**Q: `chrome.runtime.onUpdateAvailable` handling?**
**A: Defer the update until the active session ends.**

```javascript
chrome.runtime.onUpdateAvailable.addListener(() => {
  chrome.storage.session.set({ pendingUpdate: true });
  chrome.action.setBadgeText({ text: '↑' }); // Visual indicator only
});
// In sessionEnd handler: check pendingUpdate → chrome.runtime.reload()
```

---

### 9.2 Distribution

**Q: Chrome Web Store vs enterprise policy sideloading?**
**A: Enterprise policy sideloading via Google Workspace Admin Console.** For B2B internal tooling this is definitively correct:

- Zero review cycle — deploy updates instantly via GCS-hosted `.crx` or Web Store URL with force-install policy
- Extension ID is stable (controlled by Workspace admin policy, not CRX key)
- No Web Store listing fees, policy compliance overhead, or 1–3 day review delays on updates
- Managed at: Google Workspace Admin Console → Devices → Chrome → Apps & Extensions

Publish to Chrome Web Store only when distributing to external customers who do not use Google Workspace.

---

## 10. Cost Model

**A: Baseline monthly GCP cost estimate at steady state (10 users, 200 captures/day).**

| Service | Usage | Monthly cost |
|---|---|---|
| Cloud Run `hammer-api` | 6,000 req/day × 200 ms × 0.5 GB RAM | ~$3 |
| Cloud Run `hammer-portal` | 500 req/day (static, near-instant) | ~$0.50 |
| Cloud Run Jobs `hammer-export` | 20 exports/day × 5 min × 2 vCPU / 4 GB | ~$12 |
| Firestore | ~50K reads + 10K writes/day | ~$2 (free tier covers most) |
| GCS screenshots | 3 GB new/month + 36 GB stored at month 12 | ~$1.50 |
| GCS exports | 500 MB/month, deleted at 90 days | ~$0.10 |
| Cloud Logging | ~500 MB/day | ~$1 (first 50 GB/month free) |
| Secret Manager | ~6,000 API calls/day | ~$0.02 |
| Cloud Armor | Flat $5 + $0.75/million requests | ~$5.50 |
| HTTPS Load Balancer | Minimum LB charge | ~$20 |
| Vision API / OCR (if Sprint 6S passes) | 200 images/day × $1.50/1,000 | ~$9 |
| **Total steady state** | | **~$55/month** |

Peak (50 concurrent users): ~$130/month.

**Q: Billing budget alert?**
**A: Set a GCP Billing budget of $200/month with alerts at 50%, 90%, and 100%.** Add a programmatic 100% notification that publishes to Pub/Sub → Cloud Function → sets `hammer-export` and `hammer-portal` to `--max-instances 0` as a circuit breaker. A 2-hour implementation that protects against runaway FFmpeg loops.

**Q: Committed use discounts?**
**A: Not applicable.** Cloud Run charges per request and per CPU/memory second with no minimum commitment. Sustained use discounts do not apply. Cost optimization levers: right-size memory allocation, reduce cold starts with `--min-instances 1` on `hammer-api`, and use `us-central1` (lowest Cloud Run pricing region).

---

## Priority Decision Queue — All Answered

| # | Question | Decision |
|---|---|---|
| P1 | How many Cloud Run services? | **3 services + 1 Cloud Run Job** |
| P2 | Custom domain + CLB, or `*.run.app`? | **Global HTTPS LB + Cloud DNS + Google-managed cert** |
| P3 | IAP in front of Admin Portal? | **Yes — Cloud IAP replaces custom auth middleware** |
| P4 | One SA per service, min-privilege? | **Yes — 4 SAs defined; no `roles/editor` anywhere** |
| P5 | Separate GCP projects? | **2 projects: `hammer-dev` + `hammer-prod`** |
| P6 | Flat `uploads` vs subcollection? | **Flat collection with `projectId` field** |
| P7 | API keys hashed + rotation automated? | **SHA-256 in Firestore; automated quarterly via Cloud Scheduler** |
| P8 | CI/CD replacing `deploy.ps1`? | **GitHub Actions + Workload Identity Federation** |
| P9 | SLOs defined? | **4 SLOs as Cloud Monitoring SLO objects** |
| P10 | Data residency / PII policy? | **`us-central1`; screenshots = `CONFIDENTIAL`; Cloud DLP deferred post-MVP** |
