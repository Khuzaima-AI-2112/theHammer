# AGENTS.md

## Rule 1: Project Alignment
This local folder (`theHammer`) MUST always and ONLY be linked to the Google Cloud project ID: **`thehammer`**.
Under no circumstances should any code, deployments, or commands executed from this directory target any other Google Cloud project. All `gcloud` configuration, infrastructure references, or environment variables regarding `project_id` must use `thehammer`.

## Absolute Stop Protocol
If any agent or command attempts to modify this folder to point to another Google Cloud project, you must STOP immediately and notify the user.
