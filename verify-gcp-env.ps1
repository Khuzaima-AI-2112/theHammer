# verify-gcp-env.ps1
# This script ensures that the correct Google Cloud configuration and project are active.

param (
    [string]$ExpectedProject = "thehammer",
    [string]$ExpectedConfig = "thehammer",
    [string]$Account = $env:GCP_ACCOUNT
)

Write-Host "Verifying Google Cloud Environment..." -ForegroundColor Cyan

# 1. Activate configuration profile if it exists
$configs = gcloud config configurations list --format="value(name)"
if ($configs -contains $ExpectedConfig) {
    Write-Host "Activating configuration profile: $ExpectedConfig"
    gcloud config configurations activate $ExpectedConfig --quiet 2>$null
} else {
    Write-Host "Notice: Configuration profile '$ExpectedConfig' not found. Using current active configuration." -ForegroundColor Yellow
}

# 2. Set active project explicitly
Write-Host "Setting project to: $ExpectedProject"
gcloud config set project $ExpectedProject --quiet 2>$null

# 3. Handle core account check dynamically
$CurrentAccount = gcloud config get-value core/account 2>$null

if ($Account) {
    Write-Host "Setting core account to: $Account"
    gcloud config set core/account $Account --quiet 2>$null
    $CurrentAccount = $Account
}

# 4. Optional: Refresh Application Default Credentials quota project
Write-Host "Setting ADC quota project to: $ExpectedProject"
gcloud auth application-default set-quota-project $ExpectedProject --quiet 2>$null

Write-Host "`n--- Verification Results ---" -ForegroundColor Yellow

$CurrentConfig = gcloud config configurations list --filter="is_active:true" --format="value(name)"
$CurrentProject = gcloud config get-value project 2>$null
if (-not $CurrentAccount) {
    $CurrentAccount = gcloud config get-value core/account 2>$null
}

Write-Host "Active Profile: $CurrentConfig"
Write-Host "Active Project: $CurrentProject"
Write-Host "Active Account: $CurrentAccount"

if (-not $CurrentAccount) {
    Write-Host "`nWARNING: No gcloud account is authenticated. Please run 'gcloud auth login'." -ForegroundColor Yellow
} elseif ($CurrentProject -eq $ExpectedProject) {
    Write-Host "`nSUCCESS: The environment project context ($CurrentProject) is correctly configured." -ForegroundColor Green
} else {
    Write-Host "`nERROR: Expected project '$ExpectedProject', but current project is '$CurrentProject'." -ForegroundColor Red
    exit 1
}

