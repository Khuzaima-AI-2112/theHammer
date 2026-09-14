param(
  [string]$ProjectId = 'thehammer',
  [string]$BucketName = 'thehammer-storage-2026'
)

$activeProject = (gcloud config get-value project)
if ($activeProject -ne 'thehammer') {
  Write-Warning "Active gcloud project is '$activeProject', expected 'thehammer'"
  exit 1
}

$REGION = 'northamerica-northeast1'
$SA = "thehammer-backend@${ProjectId}.iam.gserviceaccount.com"
$IMAGE = "${REGION}-docker.pkg.dev/${ProjectId}/thehammer/backend:latest"

Write-Host "[deploy] Step A: granting SA token creator"
gcloud iam service-accounts add-iam-policy-binding $SA --role="roles/iam.serviceAccountTokenCreator" --member="serviceAccount:$SA"

Write-Host "[deploy] Step B: CORS setup"
gcloud storage buckets update "gs://$BucketName" --cors-file=infra/cors.json

Write-Host "[deploy] Building"
# #110: staged into the Cloud Build bucket. This used "gs://$BucketName/source",
# which put a full copy of backend/ into the Captures bucket on every run.
gcloud builds submit --tag $IMAGE --gcs-source-staging-dir "gs://thehammer_cloudbuild/source" ./backend

Write-Host "[deploy] Deploying"
$deployArgs = @(
  "deploy", "thehammer-backend",
  "--image", $IMAGE,
  "--region", $REGION,
  "--platform", "managed",
  "--allow-unauthenticated",
  "--min-instances", "0",
  "--max-instances", "5",
  "--memory", "256Mi",
  "--timeout", "30s",
  "--set-secrets", "API_KEY=thehammer-api-key:latest",
  "--set-env-vars", "GCS_BUCKET=$BucketName",
  "--service-account", $SA
)
& gcloud run @deployArgs

Write-Host "[deploy] Verify Health"
$SERVICE_URL = gcloud run services describe thehammer-backend --region $REGION --format="value(status.url)"
Write-Host "Service URL: $SERVICE_URL"
$resp = Invoke-RestMethod -Uri "$SERVICE_URL/health" -Method GET
Write-Host "Health Check: $($resp.status)"
