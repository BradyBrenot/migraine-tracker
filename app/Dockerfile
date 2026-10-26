# ── stage 1: build the frontend ──────────────────────────────────────
FROM node:24-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig*.json tailwind.config.js postcss.config.js components.json* ./
COPY src ./src
COPY shared ./shared
COPY public ./public
RUN npm run build

# ── stage 2: server runtime (node:sqlite is built into Node 24) ─────
FROM node:24-bookworm-slim
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund
# every runtime server module (index.js + imported .js modules);
# test/ and local data are not copied into the runtime image
COPY server/*.js ./server/
# shared/*.ts (datetime, inventory, …) is imported directly by the server
# through Node 24 native type-stripping, so the runtime image needs the
# erasable-syntax TypeScript sources too.
COPY shared ./shared
COPY --from=web /app/dist ./dist
ENV DATA_DIR=/data
ENV PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
