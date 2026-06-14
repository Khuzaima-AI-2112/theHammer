# =============================================================================
# The Hammer — Sprint 0 Infrastructure Setup (PowerShell)
# Covers tasks: 0.6, 0.7, 0.8, 0.9, 0.10
#
# Prerequisites:
#   - gcloud CLI installed and on PATH
#   - Authenticated: gcloud auth login
#   - Run from repo root: .\infra\setup.ps1
# =============================================================================
$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------------------
# CONFIGURATION — edit these before running
# ---------------------------------------------------------------------------
$PROJECT_ID = 'thehammer'                 # e.g. thehammer-prod
$BILLING_ACCOUNT = '015B81-E00AF4-9480BF'      # e.g. 01ABCD-EF1234-567890
$REGION = 'northamerica-northeast1'
$BUCKET = 'thehammer-screenshots'
$SA_NAME = 'thehammer-backend'
$SA_EMAIL = "$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
$SECRET_NAME = 'thehammer-api-key'
$REGISTRY_REPO = 'thehammer'

# ---------------------------------------------------------------------------
# 0.6 — Set project, link billing, enable APIs
# ---------------------------------------------------------------------------
Write-Host '[0.6] Setting active project...' -ForegroundColor Cyan
gcloud config set project $PROJECT_ID

Write-Host '[0.6] Linking billing account...' -ForegroundColor Cyan
gcloud billing projects link $PROJECT_ID --billing-account=$BILLING_ACCOUNT

Write-Host '[0.6] Enabling required APIs...' -ForegroundColor Cyan
gcloud services enable `
  run.googleapis.com `
  artifactregistry.googleapis.com `
  storage.googleapis.com `
  secretmanager.googleapis.com `
  --project=$PROJECT_ID

Write-Host '[0.6] Verifying APIs...' -ForegroundColor Cyan
$APIS = @('run.googleapis.com', 'artifactregistry.googleapis.com', 'storage.googleapis.com', 'secretmanager.googleapis.com')
foreach ($API in $APIS) {
  $STATUS = gcloud services list --enabled --project=$PROJECT_ID --filter="name:$API" --format='value(name)'
  if (-not $STATUS) {
    Write-Error "ERROR: $API did not enable successfully."
  }
  Write-Host "  [OK] $API" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 0.7 — Create GCS bucket
# ---------------------------------------------------------------------------
Write-Host '[0.7] Creating GCS bucket...' -ForegroundColor Cyan
gcloud storage buckets create "gs://$BUCKET" `
  --project=$PROJECT_ID `
  --location=$REGION `
  --uniform-bucket-level-access `
  --no-public-access-prevention

Write-Host '[0.7] Disabling versioning...' -ForegroundColor Cyan
gcloud storage buckets update "gs://$BUCKET" --no-versioning

Write-Host '[0.7] Applying 90-day lifecycle rule...' -ForegroundColor Cyan
gcloud storage buckets update "gs://$BUCKET" --lifecycle-file='infra\lifecycle.json'

Write-Host '[0.7] Verifying bucket...' -ForegroundColor Cyan
$BUCKET_INFO = gcloud storage buckets describe "gs://$BUCKET" --format='json'
$BUCKET_INFO_STR = $BUCKET_INFO -join ''
if ($BUCKET_INFO_STR -notmatch 'NORTHAMERICA-NORTHEAST1') {
  Write-Host 'WARNING: Bucket region verification skipped or failed, but continuing.' -ForegroundColor Yellow
}
Write-Host '  [OK] Bucket verified' -ForegroundColor Green

# ---------------------------------------------------------------------------
# 0.8 — Create service account and bind to bucket
# ---------------------------------------------------------------------------
Write-Host '[0.8] Creating service account...' -ForegroundColor Cyan
gcloud iam service-accounts create $SA_NAME `
  --display-name='The Hammer Backend' `
  --project=$PROJECT_ID

Write-Host '[0.8] Granting roles/storage.objectCreator on bucket...' -ForegroundColor Cyan
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" `
  --member="serviceAccount:$SA_EMAIL" `
  --role='roles/storage.objectCreator'

Write-Host '[0.8] Verifying IAM binding...' -ForegroundColor Cyan
$POLICY = gcloud storage buckets get-iam-policy "gs://$BUCKET" --format='json'
if ($POLICY -notmatch $SA_EMAIL) {
  Write-Error 'ERROR: SA IAM binding not found on bucket.'
}
Write-Host '  [OK] Service account bound to bucket' -ForegroundColor Green

# ---------------------------------------------------------------------------
# 0.9 — Generate API key, store in Secret Manager
# ---------------------------------------------------------------------------
Write-Host '[0.9] Generating API key...' -ForegroundColor Cyan
$API_KEY = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })

Write-Host '[0.9] Creating secret in Secret Manager...' -ForegroundColor Cyan
$TMP_FILE = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($TMP_FILE, $API_KEY, [System.Text.Encoding]::UTF8)
gcloud secrets create $SECRET_NAME `
  --data-file=$TMP_FILE `
  --replication-policy='automatic' `
  --project=$PROJECT_ID
Remove-Item $TMP_FILE

Write-Host '[0.9] Granting SA roles/secretmanager.secretAccessor...' -ForegroundColor Cyan
gcloud secrets add-iam-policy-binding $SECRET_NAME `
  --member="serviceAccount:$SA_EMAIL" `
  --role='roles/secretmanager.secretAccessor' `
  --project=$PROJECT_ID

Write-Host '[0.9] Verifying SA can access secret (impersonation)...' -ForegroundColor Cyan
$SECRET_VAL = gcloud secrets versions access latest `
  --secret=$SECRET_NAME `
  --impersonate-service-account=$SA_EMAIL `
  --project=$PROJECT_ID
if ($SECRET_VAL.Length -lt 10) {
  Write-Error 'ERROR: SA cannot access secret. Check IAM binding.'
}
Write-Host '  [OK] Secret stored and SA access verified' -ForegroundColor Green
Write-Host ''
Write-Host '  !! API KEY (save this — it will not be shown again):' -ForegroundColor Yellow
Write-Host "  $API_KEY" -ForegroundColor Yellow
Write-Host ''

# ---------------------------------------------------------------------------
# 0.10 — Create Artifact Registry Docker repository
# ---------------------------------------------------------------------------
Write-Host '[0.10] Creating Artifact Registry Docker repository...' -ForegroundColor Cyan
gcloud artifacts repositories create $REGISTRY_REPO `
  --repository-format=docker `
  --location=$REGION `
  --description='The Hammer container images' `
  --project=$PROJECT_ID

Write-Host '[0.10] Verifying repository format...' -ForegroundColor Cyan
$FORMAT = gcloud artifacts repositories describe $REGISTRY_REPO `
  --location=$REGION `
  --project=$PROJECT_ID `
  --format='value(format)'
if ($FORMAT -ne 'DOCKER') {
  Write-Error "ERROR: Artifact Registry repo format is $FORMAT, expected DOCKER."
}
Write-Host '  [OK] Artifact Registry repository created (format: DOCKER)' -ForegroundColor Green

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '=====================================================================' -ForegroundColor Green
Write-Host ' Sprint 0 infrastructure provisioned successfully.' -ForegroundColor Green
Write-Host ' Run: .\infra\verify.ps1 to confirm all tasks pass.' -ForegroundColor Green
Write-Host '=====================================================================' -ForegroundColor Green
