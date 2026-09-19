# Jev's always-on server: one long-lived process holding the Game Boy in memory.
FROM node:22-slim

WORKDIR /app

# Install dependencies first so code changes do not invalidate the layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY server ./server
COPY public ./public
COPY tsconfig.json ./

# tsx runs the TypeScript entrypoint directly; there is no build step to keep
# in sync with the serverless bundles.
RUN npm install --no-save --no-audit --no-fund tsx@^4.19.2

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080

# A volume keeps progress across restarts even without Blob credentials.
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/server.ts"]
