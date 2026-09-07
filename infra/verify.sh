#!/usr/bin/env bash
# =============================================================================
# The Hammer — Sprint 0 Verification Checklist
# Runs all "Done when" acceptance checks from sprintplan.md tasks 0.6–0.10.
# Usage: bash infra/verify.sh
# All checks must pass (exit 0) before Sprint 1 begins.
# =============================================================================
set -euo pipefail

PROJECT_ID="YOUR_GCP_PROJECT_ID"
REGION="northamerica-northeast1"
BUCKET="thehammer-storage-2026"
SA_NAME="thehammer-backend"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
SECRET_NAME="thehammer-api-key"
REGISTRY_REPO="thehammer"

PASS=0
FAIL=0

check() {
  local ID="$1"
  local DESC="$2"
  local CMD="$3"
  if eval "${CMD}" > /dev/null 2>&1; then
    echo "  ✓ [${ID}] ${DESC}"
    PASS=$((PASS + 1))
  else
    echo "  ✗ [${ID}] ${DESC}  ← FAILED"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "The Hammer — Sprint 0 Verification"
echo "===================================="

# 0.6 — APIs enabled
check "0.6a" "run.googleapis.com enabled" \
  "gcloud services list --enabled --project=${PROJECT_ID} --filter=name:run.googleapis.com --format=value(name) | grep -q run"
check "0.6b" "artifactregistry.googleapis.com enabled" \
  "gcloud services list --enabled --project=${PROJECT_ID} --filter=name:artifactregistry.googleapis.com --format=value(name) | grep -q artifactregistry"
check "0.6c" "storage.googleapis.com enabled" \
  "gcloud services list --enabled --project=${PROJECT_ID} --filter=name:storage.googleapis.com --format=value(name) | grep -q storage"
check "0.6d" "secretmanager.googleapis.com enabled" \
  "gcloud services list --enabled --project=${PROJECT_ID} --filter=name:secretmanager.googleapis.com --format=value(name) | grep -q secretmanager"
check "0.6e" "aiplatform.googleapis.com enabled" \
  "gcloud services list --enabled --project=${PROJECT_ID} --filter=name:aiplatform.googleapis.com --format=value(name) | grep -q aiplatform"
check "0.6f" "Backend SA holds roles/aiplatform.user" \
  "gcloud projects get-iam-policy ${PROJECT_ID} --flatten='bindings[].members' --filter='bindings.members:${SA_EMAIL}' --format='value(bindings.role)' | grep -q aiplatform.user"

# 0.7 — Bucket exists in correct region and ages nothing out
check "0.7a" "Bucket gs://${BUCKET} exists" \
  "gcloud storage ls gs://${BUCKET}"
check "0.7b" "Bucket region is NORTHAMERICA-NORTHEAST1" \
  "gcloud storage buckets describe gs://${BUCKET} --format=json | grep -q NORTHAMERICA-NORTHEAST1"
# Captures are kept indefinitely (ADR 0010). A lifecycle rule can only come
# back by hand, and this is what would catch it.
#
# The describe is captured first rather than piped straight into grep, so the
# check fails closed. An unauthenticated or misdirected gcloud prints nothing,
# and nothing does not match 'rule' — which would report a bucket nobody could
# even see as free of a rule.
check "0.7c" "Bucket has no lifecycle rule" \
  "LC=\$(gcloud storage buckets describe gs://${BUCKET} --format='value(lifecycle_config)') && ! grep -q rule <<< \"\${LC}\""

# 0.8 — Service account IAM binding on bucket
check "0.8" "SA ${SA_EMAIL} has objectCreator on bucket" \
  "gcloud storage buckets get-iam-policy gs://${BUCKET} --format=json | grep -q ${SA_EMAIL}"

# 0.9 — Secret exists and SA can access it
check "0.9a" "Secret ${SECRET_NAME} exists" \
  "gcloud secrets describe ${SECRET_NAME} --project=${PROJECT_ID}"
check "0.9b" "SA can access secret (impersonation)" \
  "gcloud secrets versions access latest --secret=${SECRET_NAME} --impersonate-service-account=${SA_EMAIL} --project=${PROJECT_ID} | wc -c | awk '{if(\$1>10) exit 0; else exit 1}'"

# 0.10 — Artifact Registry repo exists with DOCKER format
check "0.10" "Artifact Registry repo is format DOCKER" \
  "gcloud artifacts repositories describe ${REGISTRY_REPO} --location=${REGION} --project=${PROJECT_ID} --format=value(format) | grep -q DOCKER"

# ---------------------------------------------------------------------------
echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
  echo "Sprint 0 is NOT complete. Fix the failing checks before Sprint 1."
  exit 1
else
  echo "All Sprint 0 checks passed. Ready for Sprint 1."
  exit 0
fi
