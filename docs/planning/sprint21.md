# The Hammer — Sprint 21: Cloud Armor & Global HTTPS Load Balancer

## Goal

Provision and configure the production-grade network ingress layer: a **Global HTTPS Load Balancer** with **Serverless NEGs** for all Cloud Run services, **Google-managed SSL certificate**, **Cloud DNS**, and a **Cloud Armor WAF policy**. After this sprint, all traffic reaches `hammer-api` and `hammer-portal` through a single hardened ingress point — no more direct `*.run.app` URL access.

**Sprint P%: 🟡 81%** — All tasks follow well-documented GCP patterns. Risk concentrates in 21.15 (Cloud Armor rule tuning causing false positives on the extension's API calls) and 21.10 (end-to-end smoke test requiring DNS propagation, which can take 5–30 min).

---

## Prerequisites

The following must be verified ✅ before any Sprint 21 work begins:

| # | Pre-flight item | Verified by |
|---|---|---|
| PR.1 | `hammer-api` Cloud Run service deployed and healthy in `us-central1` | `curl $HAMMER_API_URL/health` → `{"status":"ok"}` |
| PR.2 | `hammer-portal` Cloud Run service deployed and healthy | `curl $HAMMER_PORTAL_URL/health` → `{"status":"ok"}` |
| PR.3 | Domain registrar DNS nameservers can be updated to Cloud DNS | Access confirmed to domain registrar admin panel |
| PR.4 | GCP project billing enabled | `gcloud billing projects describe $PROJECT_ID` shows linked billing account |
| PR.5 | `compute.googleapis.com` API enabled | `gcloud services enable compute.googleapis.com` |
| PR.6 | `dns.googleapis.com` API enabled | `gcloud services enable dns.googleapis.com` |
| PR.7 | `certificatemanager.googleapis.com` API enabled | `gcloud services enable certificatemanager.googleapis.com` |

---

## Architecture After This Sprint

```
Internet
    │
    ▼
Cloud Armor WAF Policy
(SQLi, XSS, rate limit 100 req/min/IP)
    │
    ▼
Global HTTPS Load Balancer  ←  Google-managed SSL cert (app.thehammer.io)
    │
    ├── /api/*  ──▶  Serverless NEG  ──▶  hammer-api   (Cloud Run, us-central1)
    │
    └── /*      ──▶  Serverless NEG  ──▶  hammer-portal (Cloud Run, us-central1)

Cloud DNS zone: thehammer.io
  A record: app.thehammer.io → LB external IP
```

> **Note on Domain Restricted Sharing (DRS):** The Google Cloud Organization has DRS enforced by default, meaning `allUsers` cannot be bound to the Cloud Run services. They are strictly private. This perfectly aligns with this architecture, as it prevents the WAF from being bypassed. However, it requires the Load Balancer to explicitly authenticate its requests to the private Cloud Run NEGs (e.g., via IAP or Backend Service attached Service Accounts).

---

## Deliverables

### Phase 1 — Cloud DNS

| # | Task | Done when | P% |
|---|---|---|---|
| 21.1 | Create Cloud DNS managed zone for `thehammer.io` | `gcloud dns managed-zones describe hammer-zone` returns zone with `dnsName: thehammer.io.` | 🟢 97% |
| 21.2 | Update domain registrar NS records to Cloud DNS nameservers | `dig NS thehammer.io` returns the 4 Cloud DNS nameservers (allow up to 48 h propagation; verified with `dig` from 2 independent resolvers) | 🟡 82% |
| 21.3 | Create A record placeholder for `app.thehammer.io` | Record created pointing to `0.0.0.0` (updated to real LB IP in task 21.8) | 🟢 96% |

---

### Phase 2 — Serverless NEGs

| # | Task | Done when | P% |
|---|---|---|---|
| 21.4 | Create Serverless NEG for `hammer-api` | `gcloud compute network-endpoint-groups describe hammer-api-neg` shows `cloudRun.service: hammer-api` | 🟢 96% |
| 21.5 | Create Serverless NEG for `hammer-portal` | `gcloud compute network-endpoint-groups describe hammer-portal-neg` shows `cloudRun.service: hammer-portal` | 🟢 96% |
| 21.6 | Create backend services for each NEG | `hammer-api-backend` and `hammer-portal-backend` created; health checks pass (Cloud Run NEGs use implicit health checks — no custom health check needed) | 🟢 95% |

---

### Phase 3 — HTTPS Load Balancer

| # | Task | Done when | P% |
|---|---|---|---|
| 21.7 | Provision Google-managed SSL certificate for `app.thehammer.io` | Certificate Manager cert created in `PROVISIONING` state; transitions to `ACTIVE` after DNS is confirmed (task 21.2 must be complete) | 🟡 84% |
| 21.8 | Create Global HTTPS LB with URL map | LB frontend provisioned; external IP assigned; URL map routes `/api/*` → `hammer-api-backend`, `/*` → `hammer-portal-backend`; A record 21.3 updated to real LB IP | 🟡 85% |
| 21.9 | HTTP → HTTPS redirect | `curl http://app.thehammer.io/` returns `301` redirect to `https://app.thehammer.io/` | 🟢 92% |
| 21.10 | Verify end-to-end HTTPS routing | `curl https://app.thehammer.io/api/health` → `{"status":"ok"}`; `curl https://app.thehammer.io/` → portal HTML; cert is valid (no browser warning) | 🟡 83% |

---

### Phase 4 — Cloud Armor WAF Policy

| # | Task | Done when | P% |
|---|---|---|---|
| 21.11 | Create Cloud Armor security policy | Policy `hammer-waf` created and attached to `hammer-api-backend` and `hammer-portal-backend` | 🟢 95% |
| 21.12 | Add preconfigured rule: SQLi protection | Rule `sqli-stable` at priority 1000; action `deny(403)`; verified: `curl -X POST https://app.thehammer.io/api/capture -d "x=1' OR '1'='1"` → `403` | 🟡 85% |
| 21.13 | Add preconfigured rule: XSS protection | Rule `xss-stable` at priority 1001; action `deny(403)`; verified: request with `<script>alert(1)</script>` in body → `403` | 🟡 85% |
| 21.14 | Add rate limiting rule | Rule at priority 2000: throttle source IPs exceeding 100 requests/minute; action `throttle`; verified by sending 110 requests in 60 s from a single IP → requests 101+ receive `429` | 🟠 68% |
| 21.15 | Tune rules — verify extension API calls not blocked | Run 20 real extension captures through the LB; all return `2xx`; no false positives in Cloud Armor logs; adjust rule exclusions if needed | 🟠 65% |
| 21.16 | Set default rule to `allow` | All traffic not matching rules 1000–2000 passes through; default rule priority 2147483647 action `allow` confirmed | 🟢 97% |

> **21.15 mitigation:** If the extension's `multipart/form-data` screenshot POST triggers the SQLi or XSS rule, add a Cloud Armor rule exclusion on the `X-Api-Key` header and the binary body fields. Use Cloud Armor's `preview` mode first (logs matches without blocking) to identify false positives before switching rules to `deny`.

---

### Phase 5 — Security Hardening

| # | Task | Done when | P% |
|---|---|---|---|
| 21.17 | Restrict `hammer-api` Cloud Run ingress to LB only | `gcloud run services update hammer-api --ingress internal-and-cloud-load-balancing`; direct `*.run.app` URL returns `403` | 🟢 94% |
| 21.18 | Restrict `hammer-portal` Cloud Run ingress to LB only | Same as 21.17 for `hammer-portal`; direct URL returns `403` | 🟢 94% |
| 21.19 | Update CORS in `hammer-api` to `https://app.thehammer.io` | `process.env.ALLOWED_ORIGINS` updated in Secret Manager; `*.run.app` removed from CORS allowlist; extension `chrome-extension://{ID}` origin retained | 🟡 88% |

---

### Phase 6 — Observability

| # | Task | Done when | P% |
|---|---|---|---|
| 21.20 | Enable Cloud Armor request logging | `gcloud compute security-policies update hammer-waf --log-level=VERBOSE`; blocked requests appear in Cloud Logging under `compute.googleapis.com/firewall` within 5 min of a test block | 🟢 93% |
| 21.21 | Create Cloud Monitoring alert: LB 5xx rate | Alert fires when LB backend 5xx rate > 1% over 5 min; test by temporarily pointing a backend to a non-existent revision | 🟡 82% |
| 21.22 | Create Cloud Monitoring alert: Cloud Armor block rate spike | Alert fires when Cloud Armor `denied_requests` metric > 50/min (potential attack); routed to `#hammer-alerts` Slack channel | 🟡 80% |
| 21.23 | Add LB and Cloud Armor to `infra/load_balancer.tf` | All resources created in this sprint represented as Terraform resources; `terraform plan` on the live project shows zero drift | 🟠 66% |

> **21.23 note:** Importing existing GCP resources into Terraform state (`terraform import`) is more error-prone than creating them via Terraform from scratch. If time allows, prefer: tear down manually created resources and re-create them via `terraform apply`. If not, use `terraform import` and verify with `terraform plan` — zero diff is the acceptance criterion.

---

## Sprint Completion Gates

| Gate | Status |
|---|---|
| All 23 tasks verified against Done When condition | ⏳ |
| No direct `*.run.app` URLs reachable from public internet | ⏳ |
| `https://app.thehammer.io/api/health` returns `200` with valid cert | ⏳ |
| Cloud Armor blocking SQLi + XSS test payloads | ⏳ |
| Extension captures working end-to-end through LB (no false positives) | ⏳ |
| All resources in `infra/load_balancer.tf` (zero Terraform drift) | ⏳ |
| Cloud Monitoring alerts for LB 5xx and Armor block rate active | ⏳ |
| `lessons_learned.md` updated with ≥ 2 new lessons | ⏳ |

---

## gcloud Command Reference

```bash
# ── Phase 1: Cloud DNS ──────────────────────────────────────────────────────
gcloud dns managed-zones create hammer-zone \
  --dns-name="thehammer.io." \
  --description="Hammer production DNS zone" \
  --project=$PROJECT_ID

# ── Phase 2: Serverless NEGs ────────────────────────────────────────────────
gcloud compute network-endpoint-groups create hammer-api-neg \
  --region=us-central1 \
  --network-endpoint-type=serverless \
  --cloud-run-service=hammer-api \
  --project=$PROJECT_ID

gcloud compute network-endpoint-groups create hammer-portal-neg \
  --region=us-central1 \
  --network-endpoint-type=serverless \
  --cloud-run-service=hammer-portal \
  --project=$PROJECT_ID

# Backend services
gcloud compute backend-services create hammer-api-backend \
  --global --project=$PROJECT_ID
gcloud compute backend-services add-backend hammer-api-backend \
  --global \
  --network-endpoint-group=hammer-api-neg \
  --network-endpoint-group-region=us-central1 \
  --project=$PROJECT_ID

gcloud compute backend-services create hammer-portal-backend \
  --global --project=$PROJECT_ID
gcloud compute backend-services add-backend hammer-portal-backend \
  --global \
  --network-endpoint-group=hammer-portal-neg \
  --network-endpoint-group-region=us-central1 \
  --project=$PROJECT_ID

# ── Phase 3: HTTPS Load Balancer ────────────────────────────────────────────
gcloud certificate-manager certificates create hammer-cert \
  --domains="app.thehammer.io" \
  --project=$PROJECT_ID

# URL map (default backend = portal; /api/* path matcher = api)
gcloud compute url-maps create hammer-url-map \
  --default-service=hammer-portal-backend \
  --project=$PROJECT_ID

# Import path rules from url-map.yaml
gcloud compute url-maps import hammer-url-map \
  --global --source=url-map.yaml \
  --project=$PROJECT_ID

# HTTPS proxy
gcloud compute target-https-proxies create hammer-https-proxy \
  --url-map=hammer-url-map \
  --ssl-certificates=hammer-cert \
  --project=$PROJECT_ID

# Forwarding rule (reserves static external IP)
gcloud compute forwarding-rules create hammer-https-rule \
  --global \
  --target-https-proxy=hammer-https-proxy \
  --ports=443 \
  --project=$PROJECT_ID

# HTTP → HTTPS redirect (separate URL map + HTTP proxy + forwarding rule)
gcloud compute url-maps import hammer-http-redirect \
  --global --source=http-redirect.yaml \
  --project=$PROJECT_ID

# ── Phase 4: Cloud Armor ────────────────────────────────────────────────────
gcloud compute security-policies create hammer-waf \
  --description="Hammer production WAF policy" \
  --project=$PROJECT_ID

# SQLi rule
gcloud compute security-policies rules create 1000 \
  --security-policy=hammer-waf \
  --expression="evaluatePreconfiguredExpr('sqli-stable')" \
  --action=deny-403 \
  --project=$PROJECT_ID

# XSS rule
gcloud compute security-policies rules create 1001 \
  --security-policy=hammer-waf \
  --expression="evaluatePreconfiguredExpr('xss-stable')" \
  --action=deny-403 \
  --project=$PROJECT_ID

# Rate limiting rule
gcloud compute security-policies rules create 2000 \
  --security-policy=hammer-waf \
  --expression="true" \
  --action=throttle \
  --rate-limit-threshold-count=100 \
  --rate-limit-threshold-interval-sec=60 \
  --conform-action=allow \
  --exceed-action=deny-429 \
  --enforce-on-key=IP \
  --project=$PROJECT_ID

# Attach WAF to both backends
gcloud compute backend-services update hammer-api-backend \
  --global --security-policy=hammer-waf --project=$PROJECT_ID

gcloud compute backend-services update hammer-portal-backend \
  --global --security-policy=hammer-waf --project=$PROJECT_ID

# ── Phase 5: Restrict Cloud Run ingress ─────────────────────────────────────
gcloud run services update hammer-api \
  --ingress=internal-and-cloud-load-balancing \
  --region=us-central1 --project=$PROJECT_ID

gcloud run services update hammer-portal \
  --ingress=internal-and-cloud-load-balancing \
  --region=us-central1 --project=$PROJECT_ID

# ── Phase 6: Enable Cloud Armor verbose logging ─────────────────────────────
gcloud compute security-policies update hammer-waf \
  --log-level=VERBOSE --project=$PROJECT_ID
```

---

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| SSL cert stuck in `PROVISIONING` | Medium | Cert provisions only after DNS A record points to LB IP and propagates. Complete tasks in order: 21.2 → 21.3 → 21.8 → 21.7 activation. Monitor with `gcloud certificate-manager certificates describe hammer-cert`. |
| Cloud Armor blocks extension screenshot POST | High | Use `preview` mode on all rules for first 24 h. Review `compute.googleapis.com/firewall` logs before switching to `deny`. Add body-field exclusions if `multipart/form-data` triggers SQLi rule. |
| Rate limit blocks burst capture sessions | Medium | 100 req/min per IP is generous for a screenshot tool. Add an allowlist rule at priority 999 for known test IPs if needed. |
| Terraform import drift | Medium | Run `terraform plan` immediately after import. Resolve all diffs before sprint close. |
| DNS propagation > 48 h | Low | Lower NS TTL to 300 s at registrar before switching nameservers. Monitor with `dig @8.8.8.8 NS thehammer.io`. |
| LB takes > 10 min to become active | Low | Global HTTPS LBs can take 5–10 min to propagate globally. Do not run 21.10 until `gcloud compute forwarding-rules describe hammer-https-rule` shows the LB as `ACTIVE`. |
| Load Balancer gets 403 Forbidden from Cloud Run | High | Because the organization enforces Domain Restricted Sharing (DRS), Cloud Run services are strictly private. The Load Balancer *must* authenticate to Cloud Run, otherwise the GFE will block the request. Ensure the backend services are configured to generate Identity Tokens (or use IAP) so traffic passes the IAM check. |

---

## Cost Impact

| Resource | Monthly cost |
|---|---|
| Global HTTPS Load Balancer (minimum) | ~$20 |
| Cloud Armor security policy | $5 flat + $0.75/million requests |
| Cloud DNS managed zone | $0.20/zone |
| Certificate Manager certificate | Free (Google-managed) |
| **Sprint 21 total addition** | **~$26/month** |

---

## Backlog Items Unlocked by This Sprint

| Item | Notes |
|---|---|
| CDN caching for `hammer-portal` static assets | Add `--enable-cdn` to `hammer-portal-backend` |
| Per-country geo-blocking | Add Cloud Armor geo-match rule at priority 500 |
| Bot protection | Upgrade to Cloud Armor Managed Protection Plus for reCAPTCHA |
| Multi-region failover | Add `europe-west1` NEG to each backend service |
| Cloud IAP on `hammer-portal` | Sprint 9 prerequisite — LB must exist first (now done) |
