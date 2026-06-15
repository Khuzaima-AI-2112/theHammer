# Note: no TypeScript build step — source is plain JS in src/.
# The sprint spec template referenced dist/; adjusted to src/ to match
# the actual project layout (deviation documented in lessons_learned.md item 6).
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
EXPOSE 8080
CMD ["node", "src/index.js"]
