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

## 3. Revoke a Compromised User Credential

API keys no longer exist (deprecated Sprint 23, removed from the code in issue
#4). Authentication is a Firebase ID token in an `Authorization: Bearer` header,
so revocation is a Firebase Auth operation, not a Firestore edit.

**Read step 4 before you start.** Revocation is not immediate, and the previous
version of this procedure edited an `api_keys` collection that no longer exists
— it would have appeared to succeed while revoking nothing.

**Procedure:**
1. Identify the `uid` of the affected user. The Firestore `users` document ID is
   the uid; `GET /me` also returns it as `id`.
2. Disable the account and revoke its refresh tokens, via the Firebase Console
   (Authentication -> Users -> Disable account) or the Admin SDK:
   ```javascript
   const { getAuth } = require('firebase-admin/auth');
   await getAuth().updateUser(uid, { disabled: true });
   await getAuth().revokeRefreshTokens(uid);
   ```
3. Confirm the user re-authenticates through the Admin Portal once the account is
   re-enabled. There is no key for them to regenerate.
4. **Know the gap.** `backend/src/middleware/requireAuth.js` calls
   `verifyIdToken(token)` without `{ checkRevoked: true }`, so an ID token already
   issued stays accepted until it expires — up to one hour after revocation.
   Revoking refresh tokens only stops new ones being minted. If the exposure
   cannot tolerate that window, take the service offline rather than assuming
   step 2 was immediate. Closing this gap is tracked separately; it is a
   per-request behaviour change and was deliberately not made in issue #4.
5. Review Cloud Logging and the `activity` collection for unauthorized actions
   during the exposure window.
