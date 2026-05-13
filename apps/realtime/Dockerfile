# syntax=docker/dockerfile:1
#
# Single-stage Dockerfile for apps/realtime. We use tsx in production so no
# TypeScript build step — the source files ship to the container as-is.
#
# Built from the repo root via fly.toml's `dockerfile` directive, because we
# need access to pnpm-workspace.yaml and the @chessco/db workspace package.

FROM node:22-slim

# Enable pnpm via Corepack (matches the version in apps/realtime/package.json
# author's local install).
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /repo

# 1) Copy workspace manifests first so Docker can cache the `pnpm install`
#    layer when only source code changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/realtime/package.json ./apps/realtime/
COPY packages/db/package.json ./packages/db/

# 2) Install all workspace deps. --frozen-lockfile fails fast if the lockfile
#    is out of sync with package.json (important for reproducible deploys).
RUN pnpm install --frozen-lockfile

# 3) Now copy source. This layer invalidates whenever code changes, but the
#    expensive install layer above is reused.
COPY apps/realtime ./apps/realtime
COPY packages/db ./packages/db

WORKDIR /repo/apps/realtime

ENV NODE_ENV=production
EXPOSE 3001

# tsx interprets TS at startup. For a tiny WS server this is faster overall
# than a separate tsc build step and adds no startup penalty after warmup.
CMD ["pnpm", "start"]
