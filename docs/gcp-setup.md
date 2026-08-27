> **Moved.** This runbook was previously the third document inside
> `.agent/AI_GUIDANCE.md`. It is provisioning guidance only — project rules now
> live in `AGENTS.md` at the repo root, and day-two operations (rollback, flush
> stuck export, revoke key) live in `docs/runbook.md`.
>
> **Known stale values — verify against live GCP before running any of this:**
> - The preflight check expects `projectplan.md` and `sprintplan.md` in the repo
>   root. Neither is there: `projectplan.md` is in `docs/planning/`, and
>   `sprintplan.md` does not exist anywhere in the repository.
> - `$BUCKET = 'thehammer-screenshots'`, but `infra/deploy.ps1` deploys against
>   `thehammer-storage-2026`.
> - `$SECRET_NAME = 'thehammer-api-key'` provisions the API-key auth model that
>   `docs/architecture.md` §3.2 records as deprecated in favour of Firebase ID
>   tokens.
> - The closing "What's Next" link points at `./sprintplan.md`, which is a dead
>   link.

# 🔨 Antigravity — GCP Setup Guide for The Hammer

> **Goal:** Zero-assumption, 100% success-centric walkthrough to provision all Google Cloud
> infrastructure required by The Hammer Chrome extension project.
> Every step has a verification command. Do not proceed to the next phase until
> the verification passes.

---

## Before You Start — Preflight Checklist

Complete every item before running a single command. Skipping preflight is the #1 cause of failures.

| # | Item | How to verify |
|---|------|--------------|
| 1 | You have a Google Account | Sign in at [console.cloud.google.com](https://console.cloud.google.com) |
| 2 | gcloud CLI is installed | `gcloud version` → must print a version number |
| 3 | gcloud is authenticated | `gcloud auth list` → your email must appear with a `*` |
| 4 | PowerShell 5.1+ or 7+ | `$PSVersionTable.PSVersion` → Major must be ≥ 5 |
| 5 | You have a billing account | `gcloud billing accounts list` → at least one row appears |
| 6 | You are in the repo root | `ls` → you see `infra\`, `projectplan.md`, `sprintplan.md` |

**If any item fails, fix it before continuing.**

### Install gcloud CLI (if missing)

```powershell
# Download and run the Windows installer
Start-Process "https://dl.google.com/dl/cloudsdk/channels/rapid/GoogleCloudSDKInstaller.exe"
# After install, restart PowerShell, then:
gcloud init
gcloud auth login
```

### Authenticate (if not already)

```powershell
gcloud auth login
gcloud auth application-default login
```

Both commands must complete. `application-default login` is required for Secret Manager impersonation checks.

---

## Configuration — Set These Once

Open `infra\setup.ps1` and `infra\verify.ps1` in any text editor and replace the two placeholders at the top of each file:

| Placeholder | Replace with | How to find it |
|---|---|---|
| `YOUR_GCP_PROJECT_ID` | Your project ID (e.g. `thehammer-prod`) | You will create it in Phase 1 |
| `YOUR_BILLING_ACCOUNT_ID` | Your billing account ID | `gcloud billing accounts list` → copy the value in the `ACCOUNT_ID` column |

> **Tip:** Project IDs must be globally unique, 6–30 characters, lowercase letters, digits, and hyphens only. Example: `thehammer-2026`.

---

## Phase 1 — Create or Select GCP Project

### Option A — Create a new project (recommended)

```powershell
$PROJECT_ID = 'thehammer-2026'   # change to your chosen ID
gcloud projects create $PROJECT_ID --name="The Hammer"
gcloud config set project $PROJECT_ID
```

**Verify:**

```powershell
gcloud config get-value project
# Expected output: thehammer-2026  (or whatever you chose)
```

### Option B — Use an existing project

```powershell
gcloud config set project YOUR_EXISTING_PROJECT_ID
```

**Verify:**

```powershell
gcloud config get-value project
# Expected output: your project ID
```

### Link Billing

```powershell
$BILLING = 'YOUR_BILLING_ACCOUNT_ID'   # from gcloud billing accounts list
gcloud billing projects link $PROJECT_ID --billing-account=$BILLING
```

**Verify:**

```powershell
gcloud billing projects describe $PROJECT_ID --format='value(billingEnabled)'
# Expected output: True
```

> ⚠️ If `billingEnabled` is `False`, no APIs can be enabled. Double-check the billing account ID and that the account is active at [console.cloud.google.com/billing](https://console.cloud.google.com/billing).

---

## Phase 2 — Enable Required APIs

Run this single command to enable all four APIs at once:

```powershell
gcloud services enable `
  run.googleapis.com `
  artifactregistry.googleapis.com `
  storage.googleapis.com `
  secretmanager.googleapis.com `
  --project=$PROJECT_ID
```

This takes 30–90 seconds. Wait for the shell prompt to return before verifying.

**Verify each API individually:**

```powershell
$APIS = @(
  'run.googleapis.com',
  'artifactregistry.googleapis.com',
  'storage.googleapis.com',
  'secretmanager.googleapis.com'
)
foreach ($API in $APIS) {
  $STATUS = gcloud services list --enabled --project=$PROJECT_ID `
              --filter="name:$API" --format='value(name)' 2>$null
  if ($STATUS) { Write-Host "[OK] $API" -ForegroundColor Green }
  else         { Write-Host "[FAIL] $API not enabled" -ForegroundColor Red }
}
# Expected: four [OK] lines
```

> ⚠️ If any API shows `[FAIL]`, re-run the `gcloud services enable` command and wait a full 2 minutes before re-verifying. API propagation occasionally takes longer than expected.

---

## Phase 3 — Service Account & IAM

### 3.1 Create the service account

```powershell
$SA_NAME  = 'thehammer-backend'
$SA_EMAIL = "$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"

gcloud iam service-accounts create $SA_NAME `
  --display-name='The Hammer Backend' `
  --project=$PROJECT_ID
```

**Verify:**

```powershell
gcloud iam service-accounts describe $SA_EMAIL --project=$PROJECT_ID
# Expected: a block of YAML/JSON with the SA details. No error message.
```

### 3.2 Grant Storage write permission

```powershell
$BUCKET = 'thehammer-screenshots'

gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" `
  --member="serviceAccount:$SA_EMAIL" `
  --role='roles/storage.objectCreator'
```

> ⚠️ The bucket must exist before this command runs. If you hit "bucket not found", complete Phase 4 first, then return here.

**Verify:**

```powershell
$POLICY = gcloud storage buckets get-iam-policy "gs://$BUCKET" --format='json' 2>$null
if ($POLICY -match $SA_EMAIL) { Write-Host '[OK] SA bound to bucket' -ForegroundColor Green }
else                           { Write-Host '[FAIL] SA not found in bucket IAM' -ForegroundColor Red }
```

### 3.3 Grant Secret Manager read permission

```powershell
$SECRET_NAME = 'thehammer-api-key'

gcloud secrets add-iam-policy-binding $SECRET_NAME `
  --member="serviceAccount:$SA_EMAIL" `
  --role='roles/secretmanager.secretAccessor' `
  --project=$PROJECT_ID
```

> ⚠️ The secret must exist before this command runs. If you hit "secret not found", complete Phase 5 first, then return here.

**Verify:**

```powershell
gcloud secrets get-iam-policy $SECRET_NAME --project=$PROJECT_ID
# Expected: a binding block containing your SA email and roles/secretmanager.secretAccessor
```

---

## Phase 4 — Cloud Storage Bucket

### 4.1 Create the bucket

```powershell
gcloud storage buckets create "gs://$BUCKET" `
  --project=$PROJECT_ID `
  --location=northamerica-northeast1 `
  --uniform-bucket-level-access `
  --no-public-access-prevention
```

**Verify:**

```powershell
gcloud storage buckets describe "gs://$BUCKET" --format='value(location)'
# Expected output: NORTHAMERICA-NORTHEAST1
```

### 4.2 Apply the 90-day lifecycle rule

```powershell
gcloud storage buckets update "gs://$BUCKET" --lifecycle-file='infra\lifecycle.json'
```

**Verify:**

```powershell
$LC = gcloud storage buckets describe "gs://$BUCKET" --format='json(lifecycle)' 2>$null
if ($LC -match 'lifecycleConfig') { Write-Host '[OK] Lifecycle rule applied' -ForegroundColor Green }
else                               { Write-Host '[FAIL] No lifecycle rule found' -ForegroundColor Red }
```

---

## Phase 5 — Secret Manager (API Key)

### 5.1 Generate a strong API key

```powershell
$API_KEY = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
Write-Host "Your API key: $API_KEY"
# COPY THIS VALUE NOW and store it in a password manager. It will not be shown again.
```

### 5.2 Store the key in Secret Manager

```powershell
$TMP = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($TMP, $API_KEY, [System.Text.Encoding]::UTF8)

gcloud secrets create $SECRET_NAME `
  --data-file=$TMP `
  --replication-policy='automatic' `
  --project=$PROJECT_ID

Remove-Item $TMP
```

**Verify — secret exists:**

```powershell
gcloud secrets describe $SECRET_NAME --project=$PROJECT_ID
# Expected: YAML/JSON block with the secret name. No error.
```

**Verify — SA can read it:**

```powershell
$VAL = gcloud secrets versions access latest `
  --secret=$SECRET_NAME `
  --impersonate-service-account=$SA_EMAIL `
  --project=$PROJECT_ID 2>$null

if ($VAL.Length -gt 10) { Write-Host '[OK] SA can read secret' -ForegroundColor Green }
else                     { Write-Host '[FAIL] SA cannot read secret — check IAM binding in Phase 3.3' -ForegroundColor Red }
```

---

## Phase 6 — Artifact Registry (Docker Repository)

```powershell
$REGISTRY_REPO = 'thehammer'
$REGION        = 'northamerica-northeast1'

gcloud artifacts repositories create $REGISTRY_REPO `
  --repository-format=docker `
  --location=$REGION `
  --description='The Hammer container images' `
  --project=$PROJECT_ID
```

**Verify:**

```powershell
$FORMAT = gcloud artifacts repositories describe $REGISTRY_REPO `
  --location=$REGION `
  --project=$PROJECT_ID `
  --format='value(format)' 2>$null

if ($FORMAT -eq 'DOCKER') { Write-Host '[OK] Artifact Registry repo is DOCKER format' -ForegroundColor Green }
else                       { Write-Host "[FAIL] Format is '$FORMAT', expected DOCKER" -ForegroundColor Red }
```

---

## Phase 7 — Final Automated Gate

Run the full verification script. **All 11 checks must pass before Sprint 1 begins.**

```powershell
.\infra\verify.ps1
```

Expected output:

```
The Hammer — Sprint 0 Verification
====================================
  [PASS] [0.6a] run.googleapis.com enabled
  [PASS] [0.6b] artifactregistry.googleapis.com enabled
  [PASS] [0.6c] storage.googleapis.com enabled
  [PASS] [0.6d] secretmanager.googleapis.com enabled
  [PASS] [0.7a] Bucket gs://thehammer-screenshots exists
  [PASS] [0.7b] Bucket region is NORTHAMERICA-NORTHEAST1
  [PASS] [0.7c] Bucket has lifecycle rule
  [PASS] [0.8]  SA thehammer-backend@... has objectCreator on bucket
  [PASS] [0.9a] Secret thehammer-api-key exists
  [PASS] [0.9b] SA can access secret via impersonation
  [PASS] [0.10] Artifact Registry repo format is DOCKER

Results: 11 passed, 0 failed
All Sprint 0 checks passed. Ready for Sprint 1.
```

If any check shows `[FAIL]`, see the Troubleshooting section below.

---

## Troubleshooting

### "Billing account not found" or `billingEnabled: False`

- Go to [console.cloud.google.com/billing](https://console.cloud.google.com/billing)
- Confirm the account is active and not suspended
- Re-run the billing link command with the correct `ACCOUNT_ID`

### "API not enabled" after enabling

- Wait 2 minutes — API enablement can lag
- Re-run `gcloud services enable ...` and verify again
- If it persists: check that billing is linked (`billingEnabled: True`)

### "Service account already exists"

```powershell
# If you ran setup twice, the SA already exists — this is fine. Skip creation, continue to IAM binding.
gcloud iam service-accounts describe $SA_EMAIL --project=$PROJECT_ID
```

### "Bucket already exists"

GCS bucket names are globally unique. If `thehammer-screenshots` is taken:
```powershell
# Choose a unique name, e.g. add your project ID as suffix
$BUCKET = "thehammer-screenshots-$PROJECT_ID"
# Update this variable in setup.ps1 and verify.ps1 too
```

### "Secret already exists"

```powershell
# Add a new version to the existing secret instead of creating a new one
$TMP = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($TMP, $API_KEY, [System.Text.Encoding]::UTF8)
gcloud secrets versions add $SECRET_NAME --data-file=$TMP --project=$PROJECT_ID
Remove-Item $TMP
```

### "SA cannot read secret" (check 0.9b fails)

The IAM binding from Phase 3.3 may not have propagated yet. Wait 60 seconds and re-run `verify.ps1`. If still failing:
```powershell
# Confirm the binding exists
gcloud secrets get-iam-policy $SECRET_NAME --project=$PROJECT_ID
# If the SA email is missing, re-run the Phase 3.3 gcloud secrets add-iam-policy-binding command
```

### "Permission denied" on any gcloud command

Your authenticated account may lack the required role:
```powershell
# Grant yourself Owner on the project (if you own it)
gcloud projects add-iam-policy-binding $PROJECT_ID `
  --member="user:YOUR_EMAIL@gmail.com" `
  --role='roles/owner'
```

### Artifact Registry "already exists"

```powershell
# Describe it to confirm it's DOCKER format
gcloud artifacts repositories describe thehammer `
  --location=northamerica-northeast1 `
  --project=$PROJECT_ID `
  --format='value(format)'
# If it returns DOCKER, you're good — verify.ps1 check 0.10 will pass
```

---

## Phase 8 — The First Administrator

Everything above provisions infrastructure. This provisions the first *person*.

theHammer is invite-only (ADR 0012): an administrator invites everyone else, and
their `users` record is created when they accept. The first administrator is the
one who cannot be invited, so the backend accepts a single configured address.

**Skipping this leaves a working deployment that nobody can sign in to.** The
extension will authenticate against Google, the window will close, and the popup
will show "Could not load projects", because the caller has no `users` record.
That was #33.

### 8.1 Set the bootstrap address on the backend service

```powershell
gcloud run services update thehammer-backend `
  --region northamerica-northeast1 `
  --project $PROJECT_ID `
  --update-env-vars BOOTSTRAP_ADMIN_EMAIL=founder@example.com
# Expected: a new revision, serving 100% of traffic
```

Use the Google address the first administrator will actually sign in with. The
comparison is case-insensitive and exact — no domain wildcards.

### 8.2 Sign in once, and create the workspace

The address holder signs in to the portal, then calls the workspace route with
their Firebase ID token:

```powershell
# ID_TOKEN comes from the signed-in browser session (DevTools → Application →
# IndexedDB → firebaseLocalStorageDb), or from the extension after sign-in.
curl -X POST "$BACKEND_URL/admin/workspaces" `
  -H "Authorization: Bearer $ID_TOKEN" `
  -H "Content-Type: application/json" `
  -d '{\"name\":\"The Hammer\"}'
# Expected: 201, with an id and ownerId
```

That single call creates the workspace **and** the caller's `users` document
with `role: admin`. Verify in the console: Firestore → `users` should hold one
document keyed by the Firebase UID.

### 8.3 Unset the bootstrap address

```powershell
gcloud run services update thehammer-backend `
  --region northamerica-northeast1 `
  --project $PROJECT_ID `
  --remove-env-vars BOOTSTRAP_ADMIN_EMAIL
```

Not strictly required — the route already refuses a second workspace to the same
owner — but the variable has no further purpose and anyone who can read the
service configuration can see who holds it.

### 8.4 Everyone after the first

Administrators invite by email:

```
POST /admin/workspaces/invites   { "email": "...", "role": "user" }
```

The invitation is single-use and expires after seven days. **It is not emailed
yet** — `POST /admin/workspaces/invites` writes the token to the service log
with a `TODO` where the delivery should be, so the token has to be carried to
the invitee by hand for now. The invitee signs in and calls:

```
POST /admin/workspaces/join      { "token": "..." }
```

which creates their `users` record with the role the invitation named.

---

## What's Next — Sprint 1

Once `verify.ps1` reports `11 passed, 0 failed`, the infrastructure is complete.

Sprint 1 builds the Chrome extension shell:
- `extension/manifest.json` (Manifest V3)
- Popup/options page to save Project, Tool, and Name
- Background service worker for keyboard shortcut and action button
- Content script for the floating capture button
- First end-to-end screenshot capture test

See [`sprintplan.md`](./sprintplan.md) for the full task list.
