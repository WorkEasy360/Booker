# WorkeasyBooking: one image with the API and the built web app; the API serves the app on the same origin
# (WEB_DIST_DIR). Railway, and any other container host, builds it from the project root (docs/RAILWAY.md).
# The image holds no data and no secrets: the database and uploads live on a mounted volume (DB_PATH, UPLOAD_DIR),
# settings come from the host's variables, and .dockerignore keeps .env files, databases and backups out of the build.
FROM node:24.19.0-bookworm-slim

WORKDIR /app

# Dependencies first, so they are cached between builds. --ignore-scripts: the database driver ships ready-made
# binaries, which npm would otherwise try to recompile (docs/DEPLOYMENT.md, "Requirements").
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --ignore-scripts --no-audit --no-fund

# Build the web app (dist/) and the API (server/dist/). The web app's build tools are not needed afterwards; the
# server's are kept, because npm run org:create and the db:* scripts use them.
COPY . .
RUN npm run build && rm -rf node_modules \
 && cd server && npm run build \
 && node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()"

# Production mode: the server refuses to start unless DB_PATH is an absolute path outside /app (the volume).
ENV NODE_ENV=production \
    WEB_DIST_DIR=/app/dist
WORKDIR /app/server
# The host sets PORT (Railway does); without it the API listens on 3001.
CMD ["node", "dist/index.js"]
