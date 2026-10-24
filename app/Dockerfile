# ── stage 1: build the frontend ──────────────────────────────────────
FROM node:24-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig*.json tailwind.config.js postcss.config.js components.json* ./
COPY src ./src
RUN npm run build

# ── stage 2: server runtime (node:sqlite is built into Node 24) ─────
FROM node:24-bookworm-slim
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund
COPY server/index.js ./server/
COPY --from=web /app/dist ./dist
ENV DATA_DIR=/data
ENV PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
