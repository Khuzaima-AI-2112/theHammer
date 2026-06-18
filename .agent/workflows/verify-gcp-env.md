---
description: Ensure the correct Google Cloud Project and Account are configured
---

This workflow is meant to be run whenever the user asks to verify their Google Cloud environment, or right at the start of a session to guarantee we are targeting the right account.

// turbo-all
1. Run the environment verification powershell script
```powershell
./verify-gcp-env.ps1
```

2. Confirm with the user that the output shows `SUCCESS` and that `thehammer` is the active configuration and project.
