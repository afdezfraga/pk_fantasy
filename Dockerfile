# One image, one process, one SQLite file.
#
# Built on the box it runs on, so `prisma generate` always produces an engine for the right
# architecture and `binaryTargets` never has to be guessed. Debian rather than Alpine: both
# Prisma engines are dynamically linked against libssl.so.3, and musl is a reliable source of
# "query engine not found" on ARM.
#
# No `output: 'standalone'`, on purpose. Standalone drops node_modules — including the `prisma`
# CLI, its schema engine and `tsx`, which are exactly what applies the schema and seeds the
# catalog on a fresh volume, and what you want for `docker compose exec` later. It saves image
# size, which is the one thing this deployment has plenty of.

FROM node:22-bookworm-slim

# openssl: both Prisma engines link against libssl.so.3 / libcrypto.so.3.
# sqlite3: the WAL pragma, hot backups, and a quick look at the league's data on the box.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates sqlite3 \
 && rm -rf /var/lib/apt/lists/*

# The league database lives on a volume mounted here. Creating the directory in the image with
# the right owner is what makes a fresh *named* volume writable by a non-root user — Docker
# seeds a new volume from this path, ownership included. A bind mount would need a host chown.
RUN mkdir -p /data && chown node:node /data

# Everything below is created by `node`, so no recursive chown over a 900 MB tree is ever
# needed. `chown -R` copies every file into a new layer: it would double the image and re-run
# on every source change.
RUN mkdir -p /app && chown node:node /app
WORKDIR /app
USER node

ENV NEXT_TELEMETRY_DISABLED=1

# Its own layer, so editing a page doesn't reinstall the world.
#
# NODE_ENV deliberately stays unset until after the build: setting it to production here would
# make `npm ci` skip devDependencies, and next, prisma, tsx and tailwind all live there.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

COPY --chown=node:node . .

# git does not always preserve the exec bit through a clone.
RUN chmod +x deploy/entrypoint.sh deploy/backup.sh

# Nothing connects to the database during the build: every league page is force-dynamic, `/` and
# `/login` reach cookies() before Prisma, and the health route is force-dynamic. The URL below
# points at a directory that cannot exist, so if that ever stops being true the build fails
# loudly instead of quietly succeeding against a throwaway file.
RUN npx prisma generate \
 && DATABASE_URL="file:/nonexistent/build-must-not-connect.db" npm run build

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["./deploy/entrypoint.sh"]
# Invoked through the bin shim rather than `npx`, so the server is PID 1 and SIGTERM reaches it
# directly — npx would run it as a child and swallow the signal, costing SQLite a clean shutdown.
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
