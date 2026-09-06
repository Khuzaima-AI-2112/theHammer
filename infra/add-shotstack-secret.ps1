# =============================================================================
# The Hammer — Provision the Shotstack API key (#90)
#
# Standalone and idempotent-ish, unlike setup.ps1 (a one-time Sprint 0 script
# already run against this project) — this only touches Secret Manager and
# IAM for one new secret, so it's safe to run on its own without re-running
# Sprint 0's bucket/service-account/registry creation.
#
# Prerequisites:
#   - gcloud CLI installed and on PATH, authenticated: gcloud auth login
#   - The service account and Secret Manager API from setup.ps1 already exist
#   - Set $env:SHOTSTACK_API_KEY_VALUE to the real key before running — the
#     key itself never appears in this file or in git.
#
# Usage:
#   $env:SHOTSTACK_API_KEY_VALUE = 'owZ...'   # the PRODUCTION key from Chris
#   .\infra\add-shotstack-secret.ps1
# =============================================================================
$ErrorActionPreference = 'Continue'

$PROJECT_ID = 'thehammer'
$SA_NAME = 'thehammer-backend'
$SA_EMAIL = "$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
$SECRET_NAME = 'shotstack-api-key'

if (-not $env:SHOTSTACK_API_KEY_VALUE) {
  Write-Error 'ERROR: Set $env:SHOTSTACK_API_KEY_VALUE to the Shotstack PRODUCTION key before running this script.'
  exit 1
}

Write-Host '[shotstack] Checking whether the secret already exists...' -ForegroundColor Cyan
$EXISTING = gcloud secrets describe $SECRET_NAME --project=$PROJECT_ID --format='value(name)' 2>$null

$TMP_FILE = [System.IO.Path]::GetTempFileName()
# NOT [System.Text.Encoding]::UTF8 — that writes a three-byte BOM (EF BB BF),
# and a secret is bytes rather than a text document, so the BOM becomes part of
# the value. This script did exactly that: the stored `shotstack-api-key` was
# 43 bytes for a 40-character key, so every Shotstack call carried a corrupted
# key in its x-api-key header. Found while chasing the same bug in
# add-internal-secret.ps1 (#105), which was modelled on this file.
$UTF8_NO_BOM = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($TMP_FILE, $env:SHOTSTACK_API_KEY_VALUE, $UTF8_NO_BOM)

$WRITTEN = [System.IO.File]::ReadAllBytes($TMP_FILE)
if ($WRITTEN.Length -ne $env:SHOTSTACK_API_KEY_VALUE.Length) {
  Write-Error "ERROR: about to store $($WRITTEN.Length) bytes for a $($env:SHOTSTACK_API_KEY_VALUE.Length)-character key. Refusing."
  Remove-Item $TMP_FILE
  exit 1
}

if ($EXISTING) {
  Write-Host '[shotstack] Secret exists — adding a new version instead of recreating...' -ForegroundColor Cyan
  gcloud secrets versions add $SECRET_NAME --data-file=$TMP_FILE --project=$PROJECT_ID
}
else {
  Write-Host '[shotstack] Creating secret in Secret Manager...' -ForegroundColor Cyan
  gcloud secrets create $SECRET_NAME `
    --data-file=$TMP_FILE `
    --replication-policy='automatic' `
    --project=$PROJECT_ID
}
Remove-Item $TMP_FILE

Write-Host '[shotstack] Granting SA roles/secretmanager.secretAccessor...' -ForegroundColor Cyan
gcloud secrets add-iam-policy-binding $SECRET_NAME `
  --member="serviceAccount:$SA_EMAIL" `
  --role='roles/secretmanager.secretAccessor' `
  --project=$PROJECT_ID

Write-Host '  [OK] Secret stored, SA granted roles/secretmanager.secretAccessor' -ForegroundColor Green
Write-Host ''
Write-Host '[shotstack] Best-effort double-check via impersonation (optional)...' -ForegroundColor Cyan
Write-Host '  This needs a DIFFERENT permission on your own account' -ForegroundColor Cyan
Write-Host '  (roles/iam.serviceAccountTokenCreator on the SA itself) than the' -ForegroundColor Cyan
Write-Host '  secretAccessor grant above — a failure here does NOT mean the' -ForegroundColor Cyan
Write-Host '  deploy will fail. Cloud Run reads the secret as itself, not by' -ForegroundColor Cyan
Write-Host '  impersonating it through your account.' -ForegroundColor Cyan
$SECRET_VAL = gcloud secrets versions access latest `
  --secret=$SECRET_NAME `
  --impersonate-service-account=$SA_EMAIL `
  --project=$PROJECT_ID 2>$null
if ($SECRET_VAL.Length -lt 10) {
  Write-Host '  [SKIPPED] Could not verify by impersonation (likely missing' -ForegroundColor Yellow
  Write-Host '  serviceAccountTokenCreator on your own account) — harmless,' -ForegroundColor Yellow
  Write-Host '  the secretAccessor grant above is the part that matters.' -ForegroundColor Yellow
}
else {
  Write-Host '  [OK] Impersonation check also passed' -ForegroundColor Green
}
Write-Host ''
Write-Host '  Next: cloudbuild.yaml already wires this secret to SHOTSTACK_API_KEY' -ForegroundColor Yellow
Write-Host '  on the backend service. Approve the next Cloud Build deploy to pick it up.' -ForegroundColor Yellow
Write-Host ''
Write-Host '  If that deploy step fails with a permission error reading the secret,' -ForegroundColor Yellow
Write-Host '  Cloud Build''s own service account (not thehammer-backend) also needs' -ForegroundColor Yellow
Write-Host '  roles/secretmanager.secretAccessor on this secret — grant it with:' -ForegroundColor Yellow
Write-Host "    gcloud secrets add-iam-policy-binding $SECRET_NAME \" -ForegroundColor Yellow
Write-Host '      --member="serviceAccount:<PROJECT_NUMBER>@cloudbuild.gserviceaccount.com" \' -ForegroundColor Yellow
Write-Host "      --role='roles/secretmanager.secretAccessor' --project=$PROJECT_ID" -ForegroundColor Yellow
