# Sprint 31: Securing Worker Endpoints (Zero-Downtime Rollout)

## The Issue: Unauthenticated Worker Endpoints (Audit Finding #1)
**Cause:** 
The internal worker endpoints (`/worker/reports` and `/worker/ocr`) in `backend/src/index.js` are currently exposed publicly without any authentication middleware. Any external actor can trigger these endpoints, potentially leading to unauthorized background data processing and Denial of Service (DoS) through asymmetric resource exhaustion.

**Evidence:**
```javascript
// backend/src/index.js
app.post('/worker/reports', express.json(), (req, res) => {
  const { reportId, projectId, reportType, dateRange } = req.body;
  generateStandardReport(reportId, projectId, reportType, dateRange);
  res.status(202).send();
});
```

---

## Proposed Solution
Implement authentication middleware specifically for the worker routes. Since these are intended for internal use (e.g., triggered by Google Cloud Tasks or Pub/Sub), the endpoints must verify an internal Service Account OIDC token or require a strict shared internal secret header.

## Zero-Downtime Implementation Strategy
Because there may be background jobs currently queued or executing, immediately enforcing authentication would result in dropped tasks (breaking changes). To achieve a 100% non-breaking transition, we must use a **Soft Enforcement** rollout strategy.

### Step-by-Step Playbook

#### Phase 1: Deploy "Audit Mode" to the Backend (Soft Enforcement)
1. Write the authentication middleware to inspect the request for the OIDC token or secret header.
2. **Do not block requests.** Instead, log the outcome:
   - If valid: Proceed normally.
   - If missing/invalid: Log a high-priority warning (`[SECURITY WARNING] Unauthenticated worker request allowed in audit mode`) but **allow the request to proceed**.
3. Deploy to production.
   - *Impact:* API is monitoring compliance, but 0% of existing, unauthenticated Cloud Tasks fail.

#### Phase 2: Deploy the Dispatcher Update
1. Update the application code that creates the worker tasks (the dispatcher) to include the required OIDC token or shared secret in the payload headers.
2. Deploy this update.
   - *Impact:* All newly created tasks will now successfully pass the auth check. Older tasks sitting in the queue will trigger the warning log but still process successfully.

#### Phase 3: Monitor the Queue & Logs
1. Monitor backend logs for the `[SECURITY WARNING]` message.
2. Wait until you stop seeing these warnings entirely. This guarantees that all pre-update tasks have finished processing and 100% of incoming traffic is now properly authenticated.

#### Phase 4: Hard Enforcement (Final Backend Deploy)
1. Update the backend middleware from Phase 1. Change the logic so that if the token is missing or invalid, it immediately returns a `401 Unauthorized` or `403 Forbidden` and drops the request.
2. Deploy the backend.
   - *Impact:* The endpoints are now fully secured. Because the queue was cleared of old tasks and all new tasks are signed, **exactly zero legitimate jobs will break.**

### Alternative Option: Route Versioning
If modifying the middleware twice is undesirable:
1. Create new, strictly authenticated routes: `/worker/v2/reports` and `/worker/v2/ocr`.
2. Update the task dispatcher to send new jobs to the `v2` endpoints.
3. Keep the old, unauthenticated `v1` endpoints active.
4. Once the Cloud Task queue is verified clear of `v1` tasks, safely delete the old routes from `index.js`.
