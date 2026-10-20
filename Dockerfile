# Self-hosted cron pinger — small Node + pnpm image.
FROM node:20-alpine

WORKDIR /app
RUN corepack enable

# Install prod deps first (better layer caching).
COPY package.json ./
RUN pnpm install --prod --no-frozen-lockfile

COPY server.js ./

ENV PORT=3000
ENV DATA_DIR=/data
EXPOSE 3000

# Persist run history across restarts.
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
