#!/usr/bin/env bash
# Root cron: 0 2 * * * /bin/bash /opt/crowdreply/ops/backup-mongo.sh
set -Eeuo pipefail
umask 077
backup_dir=/var/backups/crowdreply
mkdir -p "$backup_dir" /var/lib/crowdreply
chmod 700 "$backup_dir"
exec 9>/var/lib/crowdreply/operations.lock
flock -n 9 || { echo 'Another backup or deployment is active.' >&2; exit 1; }
container_id=$(docker ps -q --filter label=com.docker.compose.project=crowdreply --filter label=com.docker.compose.service=mongo)
[[ -n $container_id && $container_id != *$'\n'* ]] || { echo 'Expected one running production Mongo container.' >&2; exit 1; }
archive="$backup_dir/crowdreply-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"
[[ ! -e $archive ]] || { echo 'Backup name already exists.' >&2; exit 1; }
partial=$(mktemp "$backup_dir/.partial.XXXXXXXX")
trap 'rm -f "$partial"' EXIT
# The password enters the tool through a private config inside the container,
# not command arguments or host output. Node is not needed in the Mongo image.
docker exec "$container_id" bash -c '
  set -euo pipefail
  umask 077
  cfg=$(mktemp /tmp/crowdreply-dump.XXXXXXXX)
  trap '\''rm -f "$cfg"'\'' EXIT
  mongosh --quiet --nodb --eval '\''process.stdout.write(JSON.stringify({password:process.env.MONGO_INITDB_ROOT_PASSWORD}))'\'' > "$cfg"
  mongodump --config "$cfg" --host 127.0.0.1 --username "$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase admin --db crowdreply --archive --gzip --quiet
' > "$partial"
[[ -s $partial ]] || { echo 'Backup archive is empty.' >&2; exit 1; }
gzip -t "$partial"
mv "$partial" "$archive"
sha256sum "$archive" > "$archive.sha256"
# Delete only this script's completed archives after a new successful backup.
find "$backup_dir" -maxdepth 1 -type f \( -name 'crowdreply-*.archive.gz' -o -name 'crowdreply-*.archive.gz.sha256' \) -mtime +14 -delete
echo 'Mongo backup completed, gzip verified, and retention applied. A restore drill is still required.'
