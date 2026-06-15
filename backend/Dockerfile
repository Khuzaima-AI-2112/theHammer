# Sprint 4 tasks 4.10, 4.11, 4.12
# 4.10: base image pinned to digest (pinned 2026-06-15 — re-pin every 90 days)
#       Digest verified from Docker Hub registry on 2026-06-15.
#       To re-pin: docker pull node:20-alpine && docker inspect --format='{{index .RepoDigests 0}}' node:20-alpine
# 4.11: run as non-root user 'node'
# 4.12: .dockerignore uses whitelist pattern (* then allowlist)
#
# Note: source is plain JS in src/ (no TypeScript build step).
# dist/ deviation documented in lessons_learned.md item 6.
FROM node:20-alpine@sha256:afdf98210b07b586eb71fa22ba2e432e058e4cd1304d31ed60888755b8c865fb
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
# 4.11: chown BEFORE switching user so 'node' can read the files
RUN chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
