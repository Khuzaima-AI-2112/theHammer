#!/bin/bash
# Smoke test script for Cloud Build pre-deployment check
# Runs a container instance locally in Cloud Build, curls it, then exits.
# Usage: ./smoke-test.sh <IMAGE_URL>

IMAGE_URL=$1
if [ -z "$IMAGE_URL" ]; then
  echo "Usage: ./smoke-test.sh <IMAGE_URL>"
  exit 1
fi

echo "[SmokeTest] Starting container $IMAGE_URL on port 8080..."
# Run container in background, bound to 8080
docker run -d --name smoke-test-app -p 8080:8080 \
  -e NODE_ENV=test \
  -e FIRESTORE_EMULATOR_HOST= \
  "$IMAGE_URL"

# Wait for boot
echo "[SmokeTest] Waiting for boot..."
sleep 5

echo "[SmokeTest] Hitting GET /admin/dashboard/stats with no auth..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/admin/dashboard/stats)

# We expect a 401 Unauthorized because we provided no IAP auth.
# If we get a 401, the server is up and routing properly.
# If we get a 5xx or 000 (conn refused), the server failed to boot.
echo "[SmokeTest] Received HTTP $HTTP_STATUS"

if [ "$HTTP_STATUS" = "401" ]; then
  echo "[SmokeTest] PASS - Expected 401 Unauthorized."
  # Cleanup
  docker stop smoke-test-app > /dev/null 2>&1
  docker rm smoke-test-app > /dev/null 2>&1
  exit 0
else
  echo "[SmokeTest] FAIL - Expected 401, got $HTTP_STATUS"
  echo "--- DOCKER LOGS ---"
  docker logs smoke-test-app
  echo "-------------------"
  # Cleanup
  docker stop smoke-test-app > /dev/null 2>&1
  docker rm smoke-test-app > /dev/null 2>&1
  exit 1
fi
