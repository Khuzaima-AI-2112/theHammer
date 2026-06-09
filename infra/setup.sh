#!/usr/bin/env bash
# =============================================================================
# The Hammer — Sprint 0 Infrastructure Setup
# Covers tasks: 0.6, 0.7, 0.8, 0.9, 0.10
#
# Prerequisites:
#   - gcloud CLI installed and authenticated (gcloud auth login)
#   - Billing account linked to the GCP project
#   - Run once from the repo root: bash infra/setup.sh
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# CONFIGURATION — edit these before running
# ---------------------------------------------------------------------------
PROJECT_ID="YOUR_GCP_PROJECT_ID"          # e.g. thehammer-prod
BILLING_ACCOUNT="YOUR_BILLING_ACCOUNT_ID" # e.g. 01ABCD-EF1234-567890
REGION="northamerica-northeast1"
BUCKET="thehammer-screenshots"
SA_NAME="thehammer-backend"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
SECRET_NAME="thehammer-api-key"
REGISTRY_REPO="thehammer"

# ---------------------------------------------------------------------------
# 0.6 — Create GCP project and enable required APIs
# ---------------------------------------------------------------------------
echo "[0.6] Setting active project to ${PROJECT_ID}..."
gcloud config set project "${PROJECT_ID}"

echo "[0.6] Linking billing account..."
gcloud billing projects link "${PROJECT_ID}" \
  --billing-account="${BILLING_ACCOUNT}"

echo "[0.6] Enabling required APIs..."
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  --project="${PROJECT_ID}"

echo "[0.6] Verifying APIs are enabled..."
for API in run.googleapis.com artifactregistry.googleapis.com storage.googleapis.com secretmanager.googleapis.com; do
  STATUS=$(gcloud services list --enabled --project="${PROJECT_ID}" --filter="name:${API}" --format="value(name)")
  if [ -z "${STATUS}" ]; then
    echo "ERROR: ${API} did not enable successfully."
    exit 1
  fi
  echo "  ✓ ${API}"
done

# ---------------------------------------------------------------------------
# 0.7 — Create GCS bucket
# ---------------------------------------------------------------------------
echo "[0.7] Creating GCS bucket gs://${BUCKET}..."
gcloud storage buckets create "gs://${BUCKET}" \
  --project="${PROJECT_ID}" \
  --location="${REGION}" \
  --uniform-bucket-level-access \
  --no-public-access-prevention

echo "[0.7] Disabling versioning..."
gcloud storage buckets update "gs://${BUCKET}" --no-versioning

echo "[0.7] Applying 90-day lifecycle rule..."
gcloud storage buckets update "gs://${BUCKET}" \
  --lifecycle-file="infra/lifecycle.json"

echo "[0.7] Verifying bucket region and lifecycle..."
gcloud storage buckets describe "gs://${BUCKET}" --format="json(location,lifecycle)" | grep -E 'NORTHAMERICA-NORTHEAST1|lifecycleConfig'
echo "  ✓ Bucket created and lifecycle rule applied"

# ---------------------------------------------------------------------------
# 0.8 — Create service account and grant storage.objectCreator on bucket
# ---------------------------------------------------------------------------
echo "[0.8] Creating service account ${SA_NAME}..."
gcloud iam service-accounts create "${SA_NAME}" \
  --display-name="The Hammer Backend" \
  --project="${PROJECT_ID}"

echo "[0.8] Granting roles/storage.objectCreator on bucket..."
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.objectCreator"

echo "[0.8] Verifying IAM binding..."
BINDING=$(gcloud storage buckets get-iam-policy "gs://${BUCKET}" \
  --format="json" | grep -c "${SA_EMAIL}")
if [ "${BINDING}" -eq 0 ]; then
  echo "ERROR: SA IAM binding not found on bucket."
  exit 1
fi
echo "  ✓ Service account bound to bucket"

# ---------------------------------------------------------------------------
# 0.9 — Store API key in Secret Manager
# ---------------------------------------------------------------------------
echo "[0.9] Generating API key..."
API_KEY=$(openssl rand -hex 32)

echo "[0.9] Creating secret ${SECRET_NAME}..."
echo -n "${API_KEY}" | gcloud secrets create "${SECRET_NAME}" \
  --data-file=- \
  --replication-policy="automatic" \
  --project="${PROJECT_ID}"

echo "[0.9] Granting SA roles/secretmanager.secretAccessor..."
gcloud secrets add-iam-policy-binding "${SECRET_NAME}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" \
  --project="${PROJECT_ID}"

echo "[0.9] Verifying SA can access the secret (impersonation test)..."
RESULT=$(gcloud secrets versions access latest \
  --secret="${SECRET_NAME}" \
  --impersonate-service-account="${SA_EMAIL}" \
  --project="${PROJECT_ID}" 2>/dev/null | wc -c)
if [ "${RESULT}" -lt 10 ]; then
  echo "ERROR: SA cannot access secret. Check IAM binding."
  exit 1
fi
echo "  ✓ Secret stored and SA access verified"
echo ""
echo "  ⚠  API KEY (save this — it will not be shown again):"
echo "  ${API_KEY}"
echo ""

# ---------------------------------------------------------------------------
# 0.10 — Create Artifact Registry Docker repository
# ---------------------------------------------------------------------------
echo "[0.10] Creating Artifact Registry Docker repository..."
gcloud artifacts repositories create "${REGISTRY_REPO}" \
  --repository-format=docker \
  --location="${REGION}" \
  --description="The Hammer container images" \
  --project="${PROJECT_ID}"

echo "[0.10] Verifying repository..."
FORMAT=$(gcloud artifacts repositories describe "${REGISTRY_REPO}" \
  --location="${REGION}" \
  --project="${PROJECT_ID}" \
  --format="value(format)")
if [ "${FORMAT}" != "DOCKER" ]; then
  echo "ERROR: Artifact Registry repo format is ${FORMAT}, expected DOCKER."
  exit 1
fi
echo "  ✓ Artifact Registry repository created (format: DOCKER)"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "====================================================================="
echo " Sprint 0 infrastructure provisioned successfully."
echo " Run: bash infra/verify.sh to confirm all tasks pass."
echo "====================================================================="
