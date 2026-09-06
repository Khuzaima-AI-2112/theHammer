# =============================================================================
# The Hammer — Provision the internal worker secret (#105)
#
# `INTERNAL_SECRET` is what `POST /reports/generate` presents to
# `/worker/reports` and `/worker/ocr`, and what `requireWorkerAuth` checks. It
# was never set in the deployed environment, so the backend ran on the literal
# 'dev-secret' its code used to fall back to — a value published in this
# repository, on a service deployed --allow-unauthenticated. #104 found it;
# this script is the fix's other half.
#
# Unlike the Shotstack key, nobody has to supply this value: it is a machine
# secret shared between two halves of the same service, so the script generates
# it. It is never printed and never written to disk outside the temp file it
# is loaded from.
#
# Standalone, like add-shotstack-secret.ps1 — it touches Secret Manager and IAM
# for one secret and nothing else, so it is safe to run without re-running
# Sprint 0's setup.ps1.
#
# Prerequisites:
#   - gcloud CLI installed, on PATH, authenticated: gcloud auth login
#   - The service account and Secret Manager API from setup.ps1 already exist
#
# Usage:
#   .\infra\add-internal-secret.ps1            # create it if it does not exist
#   .\infra\add-internal-secret.ps1 -Rotate    # add a new version to an existing one
#
# Rotating takes effect only on the next deploy, and both halves of the service
# have to agree on the value, so -Rotate is deliberate rather than the default.
# =============================================================================
param([switch]$Rotate)

$ErrorActionPreference = 'Continue'

$PROJECT_ID = 'thehammer'
$SA_NAME = 'thehammer-backend'
$SA_EMAIL = "$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
$SECRET_NAME = 'internal-worker-secret'

# Windows PowerShell 5.1 runs on .NET Framework, where
# RandomNumberGenerator::Fill() does not exist — it is .NET Core 3.0+. The
# first run of this script called it, the call threw, $ErrorActionPreference
# = 'Continue' carried on regardless, and a freshly-zeroed byte array was
# written to Secret Manager as sixty-four '0' characters. A predictable secret
# is worse than the 'dev-secret' literal this whole ticket exists to remove.
#
# So: an API both editions have, and — the part that actually matters — the
# value is checked before it is written. Any generation failure that leaves a
# degenerate value aborts here rather than being published.
function New-InternalSecretValue {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RNGCryptoServiceProvider]::new()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $value = [System.BitConverter]::ToString($bytes).Replace('-', '').ToLower()

  if ($value.Length -ne 64) {
    throw "Generated secret is $($value.Length) characters, expected 64. Refusing to write it."
  }
  if (($value.ToCharArray() | Select-Object -Unique).Count -lt 8) {
    throw 'Generated secret has almost no distinct characters — the RNG did not run. Refusing to write it.'
  }
  return $value
}

function Write-SecretVersion($value, $create) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($tmp, $value, [System.Text.Encoding]::UTF8)
    if ($create) {
      gcloud secrets create $SECRET_NAME --data-file=$tmp `
        --replication-policy='automatic' --project=$PROJECT_ID
    }
    else {
      gcloud secrets versions add $SECRET_NAME --data-file=$tmp --project=$PROJECT_ID
    }
  }
  finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
}

Write-Host '[internal-secret] Checking whether the secret already exists...' -ForegroundColor Cyan
$EXISTING = gcloud secrets describe $SECRET_NAME --project=$PROJECT_ID --format='value(name)' 2>$null

if ($EXISTING -and -not $Rotate) {
  Write-Host '[internal-secret] Secret already exists — leaving its value alone.' -ForegroundColor Yellow
  Write-Host '  A new version would only take effect on the next deploy, and both' -ForegroundColor Yellow
  Write-Host '  the caller and the worker have to agree on it. Re-run with -Rotate' -ForegroundColor Yellow
  Write-Host '  if that is what you want.' -ForegroundColor Yellow
}
else {
  Write-Host '[internal-secret] Generating a 32-byte random secret...' -ForegroundColor Cyan
  $VALUE = New-InternalSecretValue

  if ($EXISTING) {
    Write-Host '[internal-secret] Adding a new version to the existing secret...' -ForegroundColor Cyan
  }
  else {
    Write-Host '[internal-secret] Creating secret in Secret Manager...' -ForegroundColor Cyan
  }
  Write-SecretVersion $VALUE (-not $EXISTING)

  Remove-Variable VALUE
}

Write-Host '[internal-secret] Granting SA roles/secretmanager.secretAccessor...' -ForegroundColor Cyan
gcloud secrets add-iam-policy-binding $SECRET_NAME `
  --member="serviceAccount:$SA_EMAIL" `
  --role='roles/secretmanager.secretAccessor' `
  --project=$PROJECT_ID

Write-Host '  [OK] Secret stored, SA granted roles/secretmanager.secretAccessor' -ForegroundColor Green
Write-Host ''
Write-Host '  Next: cloudbuild.yaml already wires this secret to INTERNAL_SECRET on' -ForegroundColor Yellow
Write-Host '  the backend service. Approve the next Cloud Build deploy to pick it up.' -ForegroundColor Yellow
Write-Host '  Until that deploy lands, the backend has no secret to check, so the' -ForegroundColor Yellow
Write-Host '  internal worker path refuses everyone and report generation answers' -ForegroundColor Yellow
Write-Host '  503 — deliberately loud, rather than running on a known value.' -ForegroundColor Yellow
Write-Host ''
Write-Host '  Verify after the deploy (the acceptance criterion, not the pipeline):' -ForegroundColor Yellow
Write-Host "    gcloud run services describe thehammer-backend --region northamerica-northeast1 \" -ForegroundColor Yellow
Write-Host "      --project $PROJECT_ID --format='value(spec.template.spec.containers[0].env)'" -ForegroundColor Yellow
Write-Host ''
Write-Host '  If the deploy step fails with a permission error reading the secret,' -ForegroundColor Yellow
Write-Host '  Cloud Build''s own service account (not thehammer-backend) also needs' -ForegroundColor Yellow
Write-Host '  roles/secretmanager.secretAccessor on this secret — grant it with:' -ForegroundColor Yellow
Write-Host "    gcloud secrets add-iam-policy-binding $SECRET_NAME \" -ForegroundColor Yellow
Write-Host '      --member="serviceAccount:<PROJECT_NUMBER>@cloudbuild.gserviceaccount.com" \' -ForegroundColor Yellow
Write-Host "      --role='roles/secretmanager.secretAccessor' --project=$PROJECT_ID" -ForegroundColor Yellow
