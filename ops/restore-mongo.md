# Mongo restore drill and incident recovery

Status: a local isolated MongoDB dump/restore drill passed on 2026-11-02: eight executions and eight raw responses, all collection counts and indexes preserved. It used a fresh named volume, no network/published ports, 1 GB memory and a 0.25 GB WiredTiger cache; the original stack was untouched. Production recovery/cutover and the server cron job have not been executed. Archive integrity alone is not restore proof; repeat the isolated drill periodically and after upgrades.
No production data is deleted by the commands below. Do not restore over the
production database or add `--drop` without a separate, reviewed recovery plan.

1. Choose a completed backup on the server. Confirm its SHA-256 and compression.

   ```bash
   sudo -i
   cd /opt/crowdreply
   umask 077
   dc() { docker compose --project-name crowdreply --env-file /opt/crowdreply/.env -f /opt/crowdreply/docker-compose.yml -f /opt/crowdreply/docker-compose.prod.yml "$@"; }
   archive=/var/backups/crowdreply/REPLACE_WITH_BACKUP.archive.gz
   sha256sum -c "$archive.sha256"
   gzip -t "$archive"
   ```

   **Expected:** checksum is OK and gzip exits successfully. A backup made while
   writers ran may contain cross-collection inconsistencies; prefer a maintenance
   backup for incident recovery and inspect execution/raw references afterwards.

2. Create a fresh isolated test container and new data volume. It has no network
   and no published ports. Use the same Mongo 8 image version as the backup source
   (pin a tested digest for a repeatable production drill).

   ```bash
   drill="crowdreply-restore-$(date -u +%Y%m%dT%H%M%SZ)"
   docker volume create "$drill-data"
   docker run -d --name "$drill" --network none --memory 1g --mount "type=volume,source=$drill-data,target=/data/db" mongo:8 --bind_ip 127.0.0.1 --wiredTigerCacheSizeGB 0.25
   for attempt in $(seq 1 60); do
     if docker exec "$drill" mongosh --quiet --eval 'quit(db.adminCommand({ping:1}).ok ? 0 : 1)' >/dev/null 2>&1; then break; fi
     sleep 2
   done
   docker exec "$drill" mongosh --quiet --eval 'quit(db.adminCommand({ping:1}).ok ? 0 : 1)'
   ```

   **Expected:** ping exits successfully. The drill uses an unauthenticated Mongo
   instance only because the container is isolated with `--network none` and
   loopback binding; never attach it to an application network or publish ports.
   If Mongo cannot start, inspect the kernel/rseq note in `DEPLOYMENT.md`. The local Docker Desktop drill required its documented GLIBC workaround; do not apply that to an unrelated production kernel. Two initial tmpfs drills failed; the bounded-memory named-volume drill passed.

3. Restore only the application database into the new container.

   ```bash
   docker exec -i "$drill" mongorestore --host 127.0.0.1 --archive --gzip --nsInclude 'crowdreply.*' < "$archive"
   docker exec "$drill" mongosh --quiet crowdreply --eval 'for (const name of db.getCollectionNames()) print(name + ": " + db.getCollection(name).countDocuments({}))'
   docker exec "$drill" mongosh --quiet crowdreply --eval 'const missing=db.executions.aggregate([{$match:{status:"succeeded"}},{$lookup:{from:"raw_responses",localField:"id",foreignField:"executionId",as:"raw"}},{$match:{raw:{$size:0}}},{$count:"missingRaw"}]).toArray(); printjson(missing)'
   ```

   **Expected:** mongorestore reports no failed documents; expected collections,
   counts and indexes exist. Investigate missing raw records: raw retention can
   legitimately expire old records, while recent missing records need review.
   Sample an execution, citations and extraction version references without
   exposing answer text in shared logs. Record the drill result. Stop the drill
   container afterwards with `docker stop "$drill"`; keep its volume until the
   Director approves cleanup. Do not remove a volume by guessing its name.

4. For an actual incident, hold the shared operations lock in this same root
   shell for the entire recovery and reconciliation. Backups and deployments will
   fail closed while it is held. Reload the active release only after acquiring
   the lock; a deployment may have completed during the isolated drill. Do not
   close this shell until recovery is finished.

   ```bash
   mkdir -p /var/lib/crowdreply
   exec 9>/var/lib/crowdreply/operations.lock
   flock -n 9 || { echo 'Another operation is active; abort recovery.' >&2; exit 1; }
   test ! -e /var/lib/crowdreply/pending-release || { echo 'Reconcile the interrupted release before recovery.' >&2; exit 1; }
   read -r IMAGE_NAMESPACE IMAGE_TAG < /var/lib/crowdreply/current-release
   [[ $IMAGE_NAMESPACE =~ ^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$ ]] || exit 1
   [[ $IMAGE_TAG =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || exit 1
   export IMAGE_NAMESPACE IMAGE_TAG
   for service in api worker dashboard; do
     active_id=$(dc ps --all -q "$service")
     test -n "$active_id" || { echo 'Missing application service; reconcile first.' >&2; exit 1; }
     component=api
     test "$service" != dashboard || component=dashboard
     actual_image=$(docker inspect --format '{{.Config.Image}}' "$active_id")
     test "$actual_image" = "ghcr.io/$IMAGE_NAMESPACE/$component:$IMAGE_TAG" || { echo 'Active images disagree with the release record; reconcile first.' >&2; exit 1; }
   done
   dc stop api worker
   ```

   Preserve the original Mongo volume and take a preservation dump while the lock
   is held. Do not invoke `backup-mongo.sh` here, because it acquires the same lock.
   This private config passes the password without exposing it in arguments:

   ```bash
   mkdir -p /var/backups/crowdreply
   preservation=/var/backups/crowdreply/preservation-$(date -u +%Y%m%dT%H%M%SZ).archive.gz
   docker exec "$(dc ps -q mongo)" bash -c '
     set -euo pipefail
     umask 077
     cfg=$(mktemp /tmp/crowdreply-preserve.XXXXXXXX)
     trap '\''rm -f "$cfg"'\'' EXIT
     mongosh --quiet --nodb --eval '\''process.stdout.write(JSON.stringify({password:process.env.MONGO_INITDB_ROOT_PASSWORD}))'\'' > "$cfg"
     mongodump --config "$cfg" --host 127.0.0.1 --username "$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase admin --db crowdreply --archive --gzip --quiet
   ' > "$preservation"
   gzip -t "$preservation"
   ```

   If preservation fails, keep writers stopped and record the failure before
   selecting the reviewed recovery point. Never overwrite the last known good
   archive. Perform steps 1–3 first. Document which paid calls may have occurred
   after the selected backup: restoring old execution/ledger state can otherwise
   cause duplicate paid calls or undercount spend.

   **Expected:** writes are stopped, the original volume remains intact, the
   selected archive has passed a restore drill, and the Director approves the
   recovery point and paid-call reconciliation plan.

5. Restore to a **new production Mongo volume**, initialized with authenticated
   Mongo root credentials, rather than changing the old volume. Stay in a private
   root session, define the `dc` helper from `DEPLOYMENT.md`, and record the old
   Mongo volume name with `docker inspect` using only its mount projection:

   ```bash
   dc stop api worker
   docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data/db"}}{{.Name}}{{end}}{{end}}' "$(dc ps -q mongo)"
   dc stop mongo
   sudoedit /opt/crowdreply/.env
   ```

   Add `MONGO_VOLUME_NAME=crowdreply_restored_YYYYMMDDTHHMMSSZ` with a new unique
   timestamp. This is a volume selector, not a credential. Check that
   `docker volume inspect THE_NEW_NAME` reports no such volume before proceeding.
   Retain the old name in the incident record. The production override uses this
   selector on every future deployment, so do not remove it after recovery.

   ```bash
   dc up -d --no-build --pull never --wait --wait-timeout 240 mongo
   restored_id=$(dc ps -q mongo)
   docker exec -i "$restored_id" bash -c '
     set -euo pipefail
     umask 077
     cfg=$(mktemp /tmp/crowdreply-restore.XXXXXXXX)
     trap '\''rm -f "$cfg"'\'' EXIT
     mongosh --quiet --nodb --eval '\''process.stdout.write(JSON.stringify({password:process.env.MONGO_INITDB_ROOT_PASSWORD}))'\'' > "$cfg"
     mongorestore --config "$cfg" --host 127.0.0.1 --username "$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase admin --archive --gzip --nsInclude "crowdreply.*"
   ' < "$archive"
   docker exec "$restored_id" mongosh --quiet --eval 'const a=db.getSiblingDB("admin"); if(!a.auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD)) quit(1); const d=db.getSiblingDB("crowdreply"); for(const name of d.getCollectionNames()) print(name+": "+d.getCollection(name).countDocuments({}))'
   ```

   Keep API and worker stopped until counts, indexes, raw references and spend
   ledger reconciliation are verified. Do not reuse the unauthenticated drill
   container as production. After reconciliation, run
   `dc up -d --no-build --pull never --wait --wait-timeout 240`, confirm health/login,
   then submit a mock question. If verification fails after cutover, stop **API and worker first**, then Mongo.
   Keep the shared operations lock held. Preserve the new recovery point and
   document any work/charges since cutover before selecting the previous volume.
   Reconcile both recovery points before restarting writers; switching the volume
   does not undo post-cutover writes or paid calls. Never delete either volume.
   Release the lock with `flock -u 9` only after verification/reconciliation is
   complete and the incident record identifies the active volume.

   **Expected:** production serves the restored data from a new authenticated
   volume, original data remains available for investigation, and queued/live
   work resumes only after reconciliation. This cutover is deliberately an
   operator-reviewed recovery action; it is not an automatic destructive script.
