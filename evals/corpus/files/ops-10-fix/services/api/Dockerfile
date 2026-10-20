# syntax=docker/dockerfile:1.7

# --- dependencies -----------------------------------------------------------
FROM node:20.17-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# The private registry token is mounted for this step only and never lands in
# a layer; CI passes it with --secret id=npmrc,src=$HOME/.npmrc.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# --- build ------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build \
 && pnpm prune --prod

# --- runtime ----------------------------------------------------------------
FROM node:20
ARG GIT_SHA=unknown
ENV NODE_ENV=production \
    PORT=8080 \
    GIT_SHA=${GIT_SHA}
WORKDIR /app
RUN groupadd --system app \
 && useradd --system --gid app --home-dir /app app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./
USER app
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/server.js"]
