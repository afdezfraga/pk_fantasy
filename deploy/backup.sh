#!/bin/sh
#
# Nightly hot backup of the league, kept for two weeks.
#
# `cp` on a live SQLite file can catch it mid-write and produce a database that opens fine and is
# subtly wrong. `sqlite3 .backup` takes a consistent snapshot of a database in use, which is the
# whole reason sqlite3 is installed in the image.
#
#   0 4 * * * cd ~/pk_fantasy && ./deploy/backup.sh >> ~/pkf-backups/backup.log 2>&1

set -e

cd "$(dirname "$0")/.."

DEST="${PKF_BACKUP_DIR:-$HOME/pkf-backups}"
KEEP_DAYS="${PKF_BACKUP_KEEP_DAYS:-14}"
STAMP=$(date +%Y-%m-%d)

mkdir -p "$DEST"

docker compose exec -T app sqlite3 /data/league.db ".backup '/data/backup.tmp'"
docker compose cp app:/data/backup.tmp "$DEST/league-$STAMP.db"
docker compose exec -T app rm -f /data/backup.tmp

find "$DEST" -name 'league-*.db' -mtime "+$KEEP_DAYS" -delete

echo "$(date -Is)  backed up to $DEST/league-$STAMP.db ($(du -h "$DEST/league-$STAMP.db" | cut -f1))"
