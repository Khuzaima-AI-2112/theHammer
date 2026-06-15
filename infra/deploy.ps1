# ─────────────────────────────────────────────────────────────────
# The Hammer — Cloud Run deploy script (Sprint 3)
# Region: northamerica-northeast1 (Montréal)
#
# Sprint 3 additions (run BEFORE deploying signing code):
#   Step A — SA self-binding: roles/iam.serviceAccountTokenCreator
#             Required for V4 signed URL generation.
#             A missing role produces a cryptic 403 from GCS — task 3.4.
#   Step B — Apply CORS config to GCS bucket
#             Required for extension to PUT directly to GCS — task 3.8.
#             Verify with: gcloud storage buckets describe gs://<BUCKET> --format="json(cors)"
#             Then: curl -X OPTIONS with your actual extension ID.
#             Wait up to 5 minutes for CORS propagation before testing.
#
# Pre-existing steps (Sprint 2):
#   1. Create GCS bucket + versioning off + 90-day lifecycle
#   2. Create SA: thehammer-backend
#   3. Grant SA roles/storage.objectCreator on bucket
#   4. Create API key in Secret Manager
#   5. Grant SA roles/secretmanager.secretAccessor
# ─────────────────────────────────────────────────────────────────

param(
  [string]$ProjectId  = $env:GCP_PROJECT_ID,
  [string]$BucketName = $env:GCS_BUCKET
)

if (-not $ProjectId) {
  Write-Error "Set `$ProjectId or GCP_PROJECT_ID env var"
  exit 1
}
if (-not $BucketName) {
  Write-Error "Set `$BucketName or GCS_BUCKET env var"
  exit 1
}

$REGION = 'northamerica-northeast1'
$SA     = "thehammer-backend@$ProjectId.iam.gserviceaccount.com"
$IMAGE  = "$REGION-docker.pkg.dev/$ProjectId/thehammer/backend:latest"

# ─────────────────────────────────────────────────────────────────
# Sprint 3 — Step A: SA self-binding for V4 signed URL generation (task 3.4)
#
# MUST run before deploying the updated backend with POST /upload-url.
# Self-binding: the SA grants itself the token creator role so Cloud Run
# can sign URLs on its own behalf.
# Verify immediately after with: gcloud iam service-accounts get-iam-policy $SA
# ─────────────────────────────────────────────────────────────────
Write-Host "[deploy] Sprint 3 — Step A: granting serviceAccountTokenCreator to SA (task 3.4)..."
gcloud iam service-accounts add-iam-policy-binding $SA `
  --role="roles/iam.serviceAccountTokenCreator" `
  --member="serviceAccount:$SA"

Write-Host "[deploy] Verifying serviceAccountTokenCreator binding..."
$iamPolicy = gcloud iam service-accounts get-iam-policy $SA --format=json | ConvertFrom-Json
$hasRole = $iamPolicy.bindings | Where-Object {
  $_.role -eq 'roles/iam.serviceAccountTokenCreator' -and
  $_.members -contains "serviceAccount:$SA"
}
if ($hasRole) {
  Write-Host "[deploy] serviceAccountTokenCreator binding VERIFIED ✓"
} else {
  Write-Warning "[deploy] WARNING: serviceAccountTokenCreator binding NOT found. Do not proceed until this is resolved."
  exit 1
}

# ─────────────────────────────────────────────────────────────────
# Sprint 3 — Step B: Apply CORS config to GCS bucket (task 3.8)
#
# Highest-risk task in the project (15% gap). Three required steps:
#   1. Apply cors.json (done here)
#   2. Describe bucket — confirm CORS is set
#   3. curl -X OPTIONS with actual extension ID — only then test the extension
# Wait up to 5 minutes for CORS propagation after apply.
# ─────────────────────────────────────────────────────────────────
Write-Host "[deploy] Sprint 3 — Step B: applying CORS config (task 3.8)..."
gcloud storage buckets update "gs://$BucketName" --cors-file=infra\cors.json

Write-Host "[deploy] Verifying CORS config on bucket..."
$corsConfig = gcloud storage buckets describe "gs://$BucketName" --format="json(cors)" | ConvertFrom-Json
if ($corsConfig.cors) {
  Write-Host "[deploy] CORS config VERIFIED ✓"
  Write-Host ($corsConfig.cors | ConvertTo-Json -Depth 5)
} else {
  Write-Warning "[deploy] WARNING: CORS config not found on bucket after apply. Wait 1-2 minutes and re-run."
}

Write-Host ""
Write-Host "[deploy] CORS applied. Before testing the extension, verify the preflight:"
Write-Host "  curl -s -o /dev/null -w '%{http_code}' -X OPTIONS \\"
Write-Host "    -H 'Origin: chrome-extension://ggdihopchjnjapikmdmafpaajikkcfdj' \\"
Write-Host "    -H 'Access-Control-Request-Method: PUT' \\"
Write-Host "    'https://storage.googleapis.com/$BucketName/test.png'"
Write-Host "  Expected: 200. If not, wait up to 5 minutes and retry."
Write-Host ""

# ─────────────────────────────────────────────────────────────────
# Build + deploy Cloud Run service
# ─────────────────────────────────────────────────────────────────
Write-Host "[deploy] Building and pushing image with Cloud Build: $IMAGE"
gcloud builds submit --tag $IMAGE --gcs-source-staging-dir "gs://$BucketName/source" ./backend

Write-Host "[deploy] Deploying to Cloud Run..."
gcloud run deploy thehammer-backend `
  --image $IMAGE `
  --region $REGION `
  --platform managed `
  --allow-unauthenticated `
  --min-instances 0 `
  --max-instances 5 `
  --memory 256Mi `
  --timeout 30s `
  --set-secrets API_KEY=thehammer-api-key:latest `
  --set-env-vars GCS_BUCKET=$BucketName `
  --service-account $SA

Write-Host "[deploy] Done. Verifying health check..."
$SERVICE_URL = gcloud run services describe thehammer-backend --region $REGION --format 'value(status.url)'
Write-Host "[deploy] Service URL: $SERVICE_URL"

try {
  $resp = Invoke-RestMethod -Uri "$SERVICE_URL/health" -Method GET
  if ($resp.status -eq 'ok') {
    Write-Host "[deploy] Health check PASSED ✓ $($resp | ConvertTo-Json)"
  } else {
    Write-Warning "[deploy] Health check returned unexpected body: $($resp | ConvertTo-Json)"
  }
} catch {
  Write-Warning "[deploy] Health check request failed: $_"
}

Write-Host ""
Write-Host "[deploy] Sprint 3 deploy complete."
Write-Host "[deploy] Next: reload the extension in chrome://extensions, then test a capture."
Write-Host "[deploy] If signed URL PUT returns 403, check Content-Type matches 'image/png' exactly (task 3.6)."
