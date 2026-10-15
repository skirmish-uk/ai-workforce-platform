# One image for the web app, the background worker and the one-off setup job (docs/DEPLOY.md).
# The worker runs TypeScript through tsx, so dev dependencies stay in the image.
FROM node:22-bookworm-slim AS base
# OpenSSL for the Prisma query engine; ca-certificates for outbound HTTPS (model APIs, Google).
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
# Manifests first, so dependency installs are cached until package*.json changes.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/auth/package.json packages/auth/
COPY packages/billing/package.json packages/billing/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/executor/package.json packages/executor/
COPY packages/integrations/package.json packages/integrations/
COPY packages/knowledge/package.json packages/knowledge/
COPY packages/llm/package.json packages/llm/
COPY packages/monitoring/package.json packages/monitoring/
COPY packages/queue/package.json packages/queue/
COPY packages/tools/package.json packages/tools/
COPY packages/ui/package.json packages/ui/
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npx prisma generate --schema packages/db/prisma/schema.prisma
# No database or secrets at build time; NEXTAUTH_URL etc. are read at runtime.
RUN cd apps/web && npx next build

FROM base AS runtime
ENV NODE_ENV=production
# Owned by the unprivileged user at copy time (a separate chown layer would double the image).
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
# Default role: the web app. compose overrides the command for the worker and setup job.
CMD ["npx", "next", "start", "apps/web", "-p", "3000"]
