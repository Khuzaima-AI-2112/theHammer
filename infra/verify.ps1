# =============================================================================
# The Hammer — Sprint 0 Verification Checklist (PowerShell)
# Runs all "Done when" acceptance checks from sprintplan.md tasks 0.6–0.10.
# Usage: .\infra\verify.ps1
# All checks must pass before Sprint 1 begins.
# =============================================================================
$ErrorActionPreference = 'SilentlyContinue'

$PROJECT_ID = 'thehammer'
$REGION = 'northamerica-northeast1'
$BUCKET = 'thehammer-storage-2026'
$SA_NAME = 'thehammer-backend'
$SA_EMAIL = "$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
$SECRET_NAME = 'thehammer-api-key'
$REGISTRY_REPO = 'thehammer'

$PASS = 0
$FAIL = 0

function Check {
  param([string]$Id, [string]$Desc, [scriptblock]$Test)
  try {
    $result = & $Test
    if ($result) {
      Write-Host "  [PASS] [$Id] $Desc" -ForegroundColor Green
      $script:PASS++
    }
    else {
      Write-Host "  [FAIL] [$Id] $Desc" -ForegroundColor Red
      $script:FAIL++
    }
  }
  catch {
    Write-Host "  [FAIL] [$Id] $Desc  <- exception: $_" -ForegroundColor Red
    $script:FAIL++
  }
}

Write-Host ''
Write-Host 'The Hammer — Sprint 0 Verification' -ForegroundColor Cyan
Write-Host '====================================' -ForegroundColor Cyan

# 0.6 — APIs enabled
Check '0.6a' 'run.googleapis.com enabled' {
  $r = gcloud services list --enabled --project=$PROJECT_ID --filter='name:run.googleapis.com' --format='value(name)' 2>$null
  $r -match 'run'
}
Check '0.6b' 'artifactregistry.googleapis.com enabled' {
  $r = gcloud services list --enabled --project=$PROJECT_ID --filter='name:artifactregistry.googleapis.com' --format='value(name)' 2>$null
  $r -match 'artifactregistry'
}
Check '0.6c' 'storage.googleapis.com enabled' {
  $r = gcloud services list --enabled --project=$PROJECT_ID --filter='name:storage.googleapis.com' --format='value(name)' 2>$null
  $r -match 'storage'
}
Check '0.6d' 'secretmanager.googleapis.com enabled' {
  $r = gcloud services list --enabled --project=$PROJECT_ID --filter='name:secretmanager.googleapis.com' --format='value(name)' 2>$null
  $r -match 'secretmanager'
}
Check '0.6e' 'aiplatform.googleapis.com enabled' {
  $r = gcloud services list --enabled --project=$PROJECT_ID --filter='name:aiplatform.googleapis.com' --format='value(name)' 2>$null
  $r -match 'aiplatform'
}
Check '0.6f' 'Backend SA holds roles/aiplatform.user' {
  $r = gcloud projects get-iam-policy $PROJECT_ID --flatten='bindings[].members' --filter="bindings.members:$SA_EMAIL" --format='value(bindings.role)' 2>$null
  $r -match 'aiplatform.user'
}

# 0.7 — Bucket exists, correct region, ages nothing out
Check '0.7a' "Bucket gs://$BUCKET exists" {
  $r = gcloud storage buckets describe "gs://$BUCKET" --format='value(name)' 2>$null
  $null -ne $r
}
Check '0.7b' 'Bucket region is NORTHAMERICA-NORTHEAST1' {
  $r = gcloud storage buckets describe "gs://$BUCKET" --format='json(location)' 2>$null
  $r -match 'NORTHAMERICA-NORTHEAST1'
}
# Captures are kept indefinitely (ADR 0010). A lifecycle rule can only come
# back by hand, and this is what would catch it.
#
# $LASTEXITCODE is checked first so the check fails closed. An unauthenticated
# or misdirected gcloud prints nothing, and nothing does not match 'rule' —
# which would report a bucket nobody could even see as free of a rule.
Check '0.7c' 'Bucket has no lifecycle rule' {
  $r = gcloud storage buckets describe "gs://$BUCKET" --format='value(lifecycle_config)' 2>$null
  ($LASTEXITCODE -eq 0) -and (($r -join '') -notmatch 'rule')
}

# 0.8 — SA has objectCreator on bucket
Check '0.8' "SA $SA_EMAIL has objectCreator on bucket" {
  $r = gcloud storage buckets get-iam-policy "gs://$BUCKET" --format='json' 2>$null
  $r -match $SA_EMAIL
}

# 0.9 — Secret exists and SA can access it
Check '0.9a' "Secret $SECRET_NAME exists" {
  $r = gcloud secrets describe $SECRET_NAME --project=$PROJECT_ID 2>$null
  $null -ne $r
}
Check '0.9b' 'SA can access secret via impersonation' {
  $r = gcloud secrets versions access latest `
    --secret=$SECRET_NAME `
    --impersonate-service-account=$SA_EMAIL `
    --project=$PROJECT_ID 2>$null
  $r.Length -gt 10
}

# 0.10 — Artifact Registry repo is DOCKER format
Check '0.10' 'Artifact Registry repo format is DOCKER' {
  $r = gcloud artifacts repositories describe $REGISTRY_REPO `
    --location=$REGION `
    --project=$PROJECT_ID `
    --format='value(format)' 2>$null
  $r -eq 'DOCKER'
}

# ---------------------------------------------------------------------------
Write-Host ''
Write-Host "Results: $PASS passed, $FAIL failed"
if ($FAIL -gt 0) {
  Write-Host 'Sprint 0 is NOT complete. Fix failing checks before Sprint 1.' -ForegroundColor Red
  exit 1
}
else {
  Write-Host 'All Sprint 0 checks passed. Ready for Sprint 1.' -ForegroundColor Green
  exit 0
}
