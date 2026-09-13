# Sprint 4 tasks 4.10, 4.11, 4.12
# 4.10: base image pinned to digest (pinned 2026-09-13 — re-pin every 90 days)
#       Digest verified from Docker Hub registry on 2026-09-13 (Node 22.23.2).
#       To re-pin: docker pull node:22-alpine && docker inspect --format='{{index .RepoDigests 0}}' node:22-alpine
#       The tag in that command must be the tag on the FROM line. On a major
#       bump, change both, or re-pinning resolves the old major (#21).
#       tests/dockerfile-repin-matches-from.test.js checks the two agree.
# 4.11: run as non-root user 'node'
# 4.12: .dockerignore uses whitelist pattern (* then allowlist)
#
# Note: source is plain JS in src/ (no TypeScript build step).
# dist/ deviation documented in lessons_learned.md item 6.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src/ ./src/
# 4.11: chown BEFORE switching user so 'node' can read the files
RUN chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
