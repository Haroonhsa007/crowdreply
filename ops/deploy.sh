#!/usr/bin/env bash
# Usage: sudo bash ops/deploy.sh lowercase-owner/repository v1.2.3
set -Eeuo pipefail
umask 077
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project_dir"
namespace=${1:?Usage: deploy.sh owner/repository version-tag}
target_tag=${2:?Usage: deploy.sh owner/repository version-tag}
[[ $namespace =~ ^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$ ]] || { echo 'Invalid image namespace.' >&2; exit 2; }
valid_tag() { [[ $1 =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]]; }
valid_tag "$target_tag" || { echo 'Use a version tag such as v1.2.3; never latest.' >&2; exit 2; }
[[ -f .env ]] || { echo 'Create the protected .env first.' >&2; exit 2; }
[[ $(stat -c %a .env) == 600 ]] || { echo '.env must have mode 600.' >&2; exit 2; }
mkdir -p /var/lib/crowdreply
exec 9>/var/lib/crowdreply/operations.lock
flock -n 9 || { echo 'Another deployment or backup is active.' >&2; exit 1; }
pending=/var/lib/crowdreply/pending-release
[[ ! -e $pending ]] || { echo 'An interrupted deployment needs reconciliation; inspect pending-release before removing it.' >&2; exit 1; }
export IMAGE_NAMESPACE="$namespace" IMAGE_TAG="$target_tag"
compose=(docker compose --project-name crowdreply --env-file .env -f docker-compose.yml -f docker-compose.prod.yml)
"${compose[@]}" config -q
previous_tag=''
present=0
for service in api worker dashboard; do
  container_id=$("${compose[@]}" ps --all -q "$service")
  [[ -n $container_id ]] || continue
  present=$((present + 1))
  image=$(docker inspect --format '{{.Config.Image}}' "$container_id")
  component=api
  [[ $service != dashboard ]] || component=dashboard
  prefix="ghcr.io/$namespace/$component:"
  [[ $image == "$prefix"* ]] || { echo 'Existing image namespace differs; reconcile manually.' >&2; exit 1; }
  old_tag=${image#"$prefix"}
  valid_tag "$old_tag" || { echo 'Existing deployment has no safe version tag.' >&2; exit 1; }
  [[ -z $previous_tag || $previous_tag == "$old_tag" ]] || { echo 'Existing application tags disagree; reconcile manually.' >&2; exit 1; }
  previous_tag=$old_tag
done
[[ $present == 0 || $present == 3 ]] || { echo 'Partial previous deployment; reconcile before updating.' >&2; exit 1; }
# Pull application images before changing running containers. Infrastructure is
# maintained separately; a routine update must not silently upgrade databases.
"${compose[@]}" pull api worker dashboard
if [[ $present == 0 ]]; then
  "${compose[@]}" pull mongo redis caddy
fi
if [[ -n $previous_tag ]]; then
  IMAGE_TAG="$previous_tag" "${compose[@]}" pull api worker dashboard
fi
printf '%s %s %s\n' "$namespace" "${previous_tag:-none}" "$target_tag" > "$pending"
rollback() {
  local result=${1:-$?}
  trap - ERR INT TERM
  if [[ -n $previous_tag ]]; then
    echo 'Deployment did not pass health checks; restoring previous application images.' >&2
    export IMAGE_TAG="$previous_tag"
    if "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 240; then
      printf '%s %s\n' "$namespace" "$previous_tag" > /var/lib/crowdreply/current-release.tmp
      mv /var/lib/crowdreply/current-release.tmp /var/lib/crowdreply/current-release
      echo 'Previous release restored and all service health checks passed.' >&2
      rm -f "$pending"
    else
      echo 'ROLLBACK FAILED: inspect service logs; data volumes were preserved.' >&2
    fi
  else
    echo 'First deployment failed; no previous release exists. Inspect logs; data volumes were preserved.' >&2
  fi
  exit "${result:-1}"
}
trap rollback ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 240
# Every service has a health check, including Caddy. HTTPS/DNS/login still need
# the external operator smoke test in DEPLOYMENT.md.
printf '%s %s\n' "$namespace" "$target_tag" > /var/lib/crowdreply/current-release.tmp
mv /var/lib/crowdreply/current-release.tmp /var/lib/crowdreply/current-release
rm -f "$pending"
trap - ERR INT TERM
echo "Release $target_tag passed all container health checks. Verify public HTTPS and login."
