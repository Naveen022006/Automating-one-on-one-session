# Web app (Next.js standalone server) and the one-off "tools" image.
#
#   docker build -t sessions-web .                          # the web server (default target)
#   docker build -t sessions-tools --target tools .         # prisma migrate deploy, admin:create, keys:rotate
#   docker build -f Dockerfile.worker -t sessions-worker .  # the BullMQ worker (separate file)
#
# No configuration or secret is baked into any image: DATABASE_URL, APP_SECRET, TOKEN_ENCRYPTION_KEY, Razorpay keys,
# and everything else in .env.example are supplied at RUN time (docker run -e / --env-file, or your platform's
# secret store). The only build-time inputs are the two public NEXT_PUBLIC_* branding values, which Next.js compiles
# into the JavaScript; they are not secrets.
#
# See doc/08-deployment.md.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# ---- deps: every dependency (the build needs TypeScript and the Prisma CLI) ---------------------------------------
FROM base AS deps
# openssl: the Prisma schema engine (used by the tools image) links against it; the slim base image does not ship it.
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: generate the Prisma client, then compile the app as a standalone server -------------------------------
FROM deps AS build
ARG NEXT_PUBLIC_BRAND_NAME
ARG NEXT_PUBLIC_SUPPORT_EMAIL
ENV NEXT_PUBLIC_BRAND_NAME=${NEXT_PUBLIC_BRAND_NAME} \
    NEXT_PUBLIC_SUPPORT_EMAIL=${NEXT_PUBLIC_SUPPORT_EMAIL}
COPY . .
RUN npx prisma generate
# BUILD_STANDALONE switches next.config.ts to output: "standalone" (traced, minimal node_modules in .next/standalone).
RUN BUILD_STANDALONE=1 npm run build

# ---- tools: Prisma CLI + scripts for one-off jobs (migrations, admin user, key rotation). Not a long-running service.
FROM deps AS tools
ENV NODE_ENV=production
COPY --chown=node:node package.json tsconfig.json prisma.config.ts ./
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node lib ./lib
COPY --from=build --chown=node:node /app/generated ./generated
# node_modules stays root-owned and read-only to the node user: the tools never need to modify it.
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# ---- runner: the web server. Only what `next build` traced as necessary; no source, no dev tooling. ---------------
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# The base image already provides an unprivileged `node` user (uid 1000).
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# (This app has no public/ directory; if one is added, copy it here as well.)
USER node
EXPOSE 3000
# Liveness only (/api/health has no dependencies). Readiness (/api/ready) is for the load balancer, not for restarts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
