#!/bin/sh
#
# Bring the schema up to date, seed the catalog the first time only, then hand over to CMD.
#
# `exec "$@"` earns its place twice: it makes `docker compose run app <cmd>` actually run <cmd>
# instead of silently starting a web server, and it leaves the Next server as PID 1 so SIGTERM
# reaches it and SQLite shuts down cleanly.

set -eu

echo "==> database: ${DATABASE_URL}"

echo "==> applying schema"
# Deliberately no --accept-data-loss. If a schema change would drop a column, this should stop
# and make someone look, not quietly delete a league's history.
node_modules/.bin/prisma db push --skip-generate

# WAL lets the draft board's five-second polling read while the single writer writes. The mode
# is recorded in the database header, so this only does real work the first time. Done with the
# sqlite3 CLI rather than Prisma's raw API: this runs before the server does, and a log line
# must never be the thing that stops the deploy.
DB_FILE=$(printf '%s' "${DATABASE_URL}" | sed -e 's/^file://' -e 's/?.*$//')
case "$DB_FILE" in
  /*) echo "==> journal mode: $(sqlite3 "$DB_FILE" 'PRAGMA journal_mode = WAL;')" ;;
  *)  echo "!!! DATABASE_URL is not an absolute file: path — refusing to guess" >&2; exit 1 ;;
esac

node deploy/bootstrap.mjs

echo "==> starting: $*"
exec "$@"
