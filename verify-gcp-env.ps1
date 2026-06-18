# verify-gcp-env.ps1
# This script ensures that the correct Google Cloud configuration is active.

$ExpectedProject = "thehammer"
$ExpectedAccount = "chris.frosztega@gmail.com"
$ExpectedConfig = "thehammer"

Write-Host "Verifying Google Cloud Environment..." -ForegroundColor Cyan

# 1. Activate the correct configuration profile
Write-Host "Activating configuration: $ExpectedConfig"
gcloud config configurations activate $ExpectedConfig --quiet

# 2. Set the project explicitly
Write-Host "Setting project to: $ExpectedProject"
gcloud config set project $ExpectedProject --quiet

# 3. Set the active account (assuming auth login has already been done in the past)
Write-Host "Setting core account to: $ExpectedAccount"
gcloud config set core/account $ExpectedAccount --quiet

# 4. Optional: Refresh Application Default Credentials quota project
Write-Host "Setting ADC quota project to: $ExpectedProject"
gcloud auth application-default set-quota-project $ExpectedProject --quiet 2>$null

Write-Host "`n--- Verification Results ---" -ForegroundColor Yellow

$CurrentConfig = gcloud config configurations list --filter="is_active:true" --format="value(name)"
$CurrentProject = gcloud config get-value project
$CurrentAccount = gcloud config get-value core/account

Write-Host "Active Profile: $CurrentConfig"
Write-Host "Active Project: $CurrentProject"
Write-Host "Active Account: $CurrentAccount"

if (($CurrentConfig -eq $ExpectedConfig) -and ($CurrentProject -eq $ExpectedProject) -and ($CurrentAccount -eq $ExpectedAccount)) {
    Write-Host "`nSUCCESS: The environment is correctly configured." -ForegroundColor Green
} else {
    Write-Host "`nERROR: There was a mismatch in configuration. Please check your gcloud installation." -ForegroundColor Red
}
