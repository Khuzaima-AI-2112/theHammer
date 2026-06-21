param (
    [string]$BrainDir = "$env:USERPROFILE\.gemini\antigravity-ide\brain",
    [string]$DestDir = "$PSScriptRoot\..\docs\walkthroughs"
)

# Ensure the destination directory exists
if (!(Test-Path $DestDir)) {
    New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
}

$Watcher = New-Object System.IO.FileSystemWatcher
$Watcher.Path = $BrainDir
$Watcher.Filter = "walkthrough.md"
$Watcher.IncludeSubdirectories = $true
$Watcher.EnableRaisingEvents = $true

Write-Host "Hammer - Walkthrough Watcher" -ForegroundColor Cyan
Write-Host "Watching for new walkthroughs in: $BrainDir"
Write-Host "Will save copies to: $DestDir"
Write-Host "Press Ctrl+C to stop."

# Keep track of last trigger time to debounce multiple events
$Global:LastEventTime = [DateTime]::MinValue

# The action to execute when a walkthrough.md is modified or created
$Action = {
    $Path = $Event.SourceEventArgs.FullPath
    
    $Now = Get-Date
    if (($Now - $Global:LastEventTime).TotalSeconds -lt 2) {
        return # Skip if triggered within the last 2 seconds
    }
    $Global:LastEventTime = $Now
    
    # Small debounce to ensure file is fully written before copying
    Start-Sleep -Milliseconds 500
    
    $Timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
    $DestPath = Join-Path $DestDir "walkthrough_$Timestamp.md"
    
    try {
        Copy-Item -Path $Path -Destination $DestPath -Force
        Write-Host "Saved new walkthrough: walkthrough_$Timestamp.md" -ForegroundColor Green
    } catch {
        Write-Host "Failed to copy walkthrough" -ForegroundColor Red
    }
}

# Register the events
$createdJob = Register-ObjectEvent $Watcher "Created" -Action $Action
$changedJob = Register-ObjectEvent $Watcher "Changed" -Action $Action

try {
    # Keep the script running
    while ($true) {
        Start-Sleep -Seconds 1
    }
} finally {
    # Cleanup on exit
    Unregister-Event -SourceIdentifier $createdJob.Name
    Unregister-Event -SourceIdentifier $changedJob.Name
    $Watcher.Dispose()
    Write-Host "Watcher stopped." -ForegroundColor Yellow
}
