# ─────────────────────────────────────────────────────────────────
# The Hammer — Cloud Run deploy script
# Region: northamerica-northeast1 (Montréal)
# Before first deploy:
#   1. Create GCS bucket:  gsutil mb -l northamerica-northeast1 gs://<YOUR_BUCKET>
#   2. Create SA:          gcloud iam service-accounts create thehammer-backend
#   3. Grant SA bucket access:
#      gsutil iam ch serviceAccount:thehammer-backend@$PROJECT_ID.iam.gserviceaccount.com:objectAdmin gs://<YOUR_BUCKET>
#   4. Create API key secret:
#      echo -n "<your-secret>" | gcloud secrets create thehammer-api-key --data-file=-
#   5. Grant SA secret access:
#      gcloud secrets add-iam-policy-binding thehammer-api-key \
#        --member="serviceAccount:thehammer-backend@$PROJECT_ID.iam.gserviceaccount.com" \
#        --role="roles/secretmanager.secretAccessor"
# ─────────────────────────────────────────────────────────────────

param(
  [string]$ProjectId = $env:GCP_PROJECT_ID,
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
$IMAGE  = "$REGION-docker.pkg.dev/$ProjectId/thehammer/backend:latest"

Write-Host "[deploy] Configuring Docker auth..."
gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet

Write-Host "[deploy] Building image: $IMAGE"
docker build -t $IMAGE ./backend

Write-Host "[deploy] Pushing image..."
docker push $IMAGE

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
  --service-account "thehammer-backend@$ProjectId.iam.gserviceaccount.com"

Write-Host "[deploy] Done. Verifying health check..."
$SERVICE_URL = gcloud run services describe thehammer-backend --region $REGION --format 'value(status.url)'
Write-Host "[deploy] Service URL: $SERVICE_URL"

try {
  $resp = Invoke-RestMethod -Uri "$SERVICE_URL/health" -Method GET
  if ($resp.status -eq 'ok') {
    Write-Host "[deploy] Health check PASSED: $($resp | ConvertTo-Json)"
  } else {
    Write-Warning "[deploy] Health check returned unexpected body: $($resp | ConvertTo-Json)"
  }
} catch {
  Write-Warning "[deploy] Health check request failed: $_"
}
