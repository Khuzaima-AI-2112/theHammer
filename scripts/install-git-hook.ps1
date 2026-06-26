# install-git-hook.ps1
# Sets up local pre-commit hook in .git/hooks/pre-commit

$HookPath = Join-Path (Get-Location) ".git/hooks/pre-commit"
$HookDir = Split-Path $HookPath

if (-not (Test-Path $HookDir)) {
    Write-Error "Could not find .git folder. Make sure to run this script from the workspace root."
    Exit 1
}

$HookContent = @"
#!/bin/sh

echo "── Running Pre-Commit Git Hooks ──"

# 1. Verify GCP Environment Context
echo "Checking GCP Environment..."
powershell.exe -ExecutionPolicy Bypass -File ./verify-gcp-env.ps1
if [ `$? -ne 0 ]; then
  echo "FAIL: GCP environment context checks failed."
  exit 1
fi

# 2. Run local backend emulator tests
echo "Running backend unit and integration tests..."
cd backend
npx -y firebase-tools emulators:exec --only firestore --project demo-hammer "npm test"
if [ `$? -ne 0 ]; then
  echo "FAIL: Backend tests failed."
  exit 1
fi

echo "Pre-commit checks passed successfully ✓"
exit 0
"@

# Write content with UTF-8 encoding without BOM to prevent git parsing errors
[System.IO.File]::WriteAllLines($HookPath, $HookContent.Split("`n"))
Write-Host "Success: Git pre-commit hook installed to $HookPath"
