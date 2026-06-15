# Sprint 4 tasks 4.10, 4.11, 4.12
# 4.10: base image pinned to digest (pinned 2026-06-15 — re-pin every 90 days)
# 4.11: run as non-root user 'node'
# 4.12: .dockerignore uses whitelist pattern (* then allowlist)
#
# Note: source is plain JS in src/ (no TypeScript build step).
# dist/ deviation documented in lessons_learned.md item 6.
FROM node:20-alpine@sha256:b4f5ff13f7bb7ee9a07caf7f2df29c0f2c02f11b9f2d17a3aa8a0c4db7ef1b6d
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
# 4.11: chown BEFORE switching user so 'node' can read the files
RUN chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
