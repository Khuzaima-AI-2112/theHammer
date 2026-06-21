# The Hammer - Operations Runbook

This document outlines standard operating procedures for incident response and maintenance tasks.

## 1. Cloud Run Revision Rollback

If a bad deployment causes widespread 5xx errors or breaks the portal, roll back traffic to the previous known-good revision.

**Procedure:**
1. List recent revisions to find the ID of the last stable one:
   ```bash
   gcloud run revisions list --service thehammer-backend --region northamerica-northeast1
   ```
2. Update traffic to point 100% to the stable revision:
   ```bash
   gcloud run services update-traffic thehammer-backend --to-revisions=thehammer-backend-XXXXX=100 --region northamerica-northeast1
   ```
3. Repeat for `thehammer-portal` if the frontend was also affected.
4. Verify the application is stable. Investigate the faulty container image logs in Cloud Logging.

## 2. Flush Stuck Export Job

If a video export job is stuck in the `processing` state for more than 15 minutes, it may need to be reset so the worker can pick it up again.

**Procedure:**
1. Query the Firestore `exports` collection for stuck jobs:
   - Identify the `exportId` of the stuck job.
2. Manually update the document's status back to `queued`:
   - Note: Can be done via the Firebase Console (Firestore Data viewer) or a custom script.
   ```javascript
   // Admin SDK snippet:
   db.collection('exports').doc('EXPORT_ID').update({ status: 'queued', updatedAt: new Date().toISOString() })
   ```
3. Verify that the Cloud Run worker picks up the job on its next polling cycle.

## 3. Revoke Compromised API Key

If a user's API key is leaked, it must be invalidated immediately to prevent unauthorized capture uploads or data access.

**Procedure:**
1. Identify the compromised API key or the `userId` associated with it.
2. If you only know the `userId`, you can deactivate all their active keys:
   - Navigate to the Firebase Console -> Firestore.
   - Go to the `api_keys` collection.
   - Filter by `userId == "TARGET_USER_ID"` and `isActive == true`.
   - Update the `isActive` field to `false`.
3. Inform the user to log into the Admin Portal and generate a new Personal API Key.
4. Review Cloud Logging and the `activity` collection for any unauthorized actions performed by that key recently.
