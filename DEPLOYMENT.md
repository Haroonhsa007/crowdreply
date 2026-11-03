# Deploy one CrowdReply server

This is an operator runbook, not a record of a deployment. No remote server, DNS
record, certificate or registry release has been exercised by these instructions. A local isolated dump/restore drill passed; production restore/cutover and scheduled backups remain unexecuted. Repeat the restore drill on the selected server before trusting backups. The
Director approves releases, provider spend and git operations.

## 1. Collect the required access

Supply an Ubuntu 24.04 LTS VPS, its public IPv4 address, the hosting account,
SSH public-key access, access to the `example.xyz` DNS panel, and a GitHub account
owning the repository and GHCR packages. Start with at least 4 vCPU, 8 GB RAM and
40 GB SSD; these are initial sizing assumptions, not validated capacity for
50,000 executions/day. Choose a lowercase `owner/repository` image namespace
and an immutable release tag such as `v0.1.0`. The release workflow publishes
`ghcr.io/owner/repository/api:TAG` and `/dashboard:TAG` when the Director pushes
a matching tag. The worker uses the API image. Do not reuse a release tag.

**What you should see:** you can sign into the server console, DNS panel and
GitHub account, and both release image tags exist in the registry.

## 2. Prepare and harden the server

Use the provider console or the existing administrative SSH session. Keep that
session open until a second terminal can log in as the new user.

```bash
sudo adduser deploy
sudo usermod -aG sudo deploy
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
sudoedit /home/deploy/.ssh/authorized_keys
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

Paste your **public** SSH key in `authorized_keys`. Never upload the private key.
In a second terminal run `ssh deploy@YOUR_SERVER_IP` and verify `sudo -v`.
Then create `/etc/ssh/sshd_config.d/00-crowdreply.conf` using `sudoedit`:

```text
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
```

```bash
sudo sshd -t
sudo systemctl reload ssh
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl ufw unattended-upgrades fail2ban dnsutils
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw enable
sudo dpkg-reconfigure -plow unattended-upgrades
sudo systemctl enable --now fail2ban
sudo timedatectl set-ntp true
sudo ufw status
timedatectl status
uname -r
```

Confirm fail2ban's SSH jail is enabled (`sudo fail2ban-client status sshd`);
if absent, enable `[sshd]` with `enabled = true` in a jail configuration and
restart fail2ban. Reboot if the kernel upgrade requires it, then reconnect.

MongoDB 8 has a documented TCMalloc/rseq issue on some Linux 7.0 kernels,
including the Docker Desktop kernel used during local validation. The production
override removes the local `GLIBC_TUNABLES` workaround. Use Ubuntu's supported
kernel and verify Mongo health. If using Linux 7.0, confirm a fixed kernel
(7.0.14 or later in that series) and the applicable MongoDB advisory before
deployment; do not silently downgrade MongoDB or copy a workaround to an
unrelated kernel. See the supplied investigation references:
[MongoDB issue](https://jira.mongodb.org/browse/SERVER-125742) and
[MongoDB TCMalloc guidance](https://www.mongodb.com/docs/manual/administration/tcmalloc-performance/).

**What you should see:** key-only login works, root/password login is disabled,
only TCP 22/80/443 are allowed inbound, updates are enabled and time is synchronized.

## 3. Install Docker Engine and Compose from Docker's repository

Run on the Ubuntu server. If it already has Docker installed, inspect and reconcile
the installation first instead of replacing a working production engine blindly.

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$VERSION_CODENAME" "$(dpkg --print-architecture)" | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

Require Docker Compose 2.24.4 or later for override reset semantics and health
waiting. Use `sudo docker`; membership in the Docker group is effectively root
access. Docker-published ports can bypass UFW, so the production override removes
all API, dashboard, Mongo and Redis host port mappings.

**What you should see:** Docker is running and Compose reports a supported version.

## 4. Set explicit DNS records

In your DNS panel create `A visibility.example.xyz → YOUR_SERVER_IPV4`. Add an
`AAAA` record only if the VPS has working public IPv6 and matching firewall rules.
Remove stale AAAA records. If you need a public API, also create
`visibility-api.example.xyz`; the default dashboard uses an internal API only.

`*.example.xyz` is a wildcard: it sends every otherwise unlisted subdomain to
the target, including typos. Prefer the two explicit names above. A DNS wildcard
does not automatically give you a wildcard TLS certificate.

```bash
dig +short A visibility.example.xyz
dig +short AAAA visibility.example.xyz
```

Caddy automatically obtains per-host certificates with publicly reachable ports
80/443 and no DNS token (HTTP-01/TLS-ALPN validation). A true wildcard certificate
requires DNS-01 and a Caddy build containing your DNS provider module; the stock
image here does not include arbitrary DNS plugins. Treat that as a separate
change, store its narrowly scoped DNS token server-side, and validate it first.

**What you should see:** DNS returns only the intended server address(es).

## 5. Place the approved release files on the server

Use the Director-approved repository URL and release tag. These commands are for
the operator; no git operation has been executed as part of preparing this runbook.

```bash
sudo apt-get install -y git
sudo install -d -o deploy -g deploy /opt/crowdreply
git clone YOUR_APPROVED_REPOSITORY_URL /opt/crowdreply
cd /opt/crowdreply
git checkout --detach YOUR_APPROVED_RELEASE_TAG
```

Alternatively copy the approved release archive containing both Compose files
and `ops/`; runtime images still come from GHCR. For private packages, run
`sudo docker login ghcr.io --username YOUR_GITHUB_USERNAME` and enter a token
with read-only package access at the password prompt. Never put the token on a
command line or into this repository. Root's Docker credentials need protection;
use a credential helper where available and revoke unused tokens.

**What you should see:** `/opt/crowdreply` contains the matching release configuration
and registry login succeeds without echoing credentials.

## 6. Generate local secrets without printing them

Run this only for a **new** deployment. It refuses to overwrite an existing `.env`.
Do not record the terminal when opening credentials. The generated hexadecimal
secrets are URL-safe, so the database URLs need no further escaping.

```bash
cd /opt/crowdreply
python3 - <<'PY'
import os, subprocess
def secret():
    return subprocess.check_output(['openssl', 'rand', '-hex', '32'], text=True).strip()
password, mongo_password, redis_password = secret(), secret(), secret()
values = {
    'OPERATOR_USERNAME': 'operator', 'OPERATOR_PASSWORD': password,
    'OPERATOR_API_KEY': secret(), 'SESSION_SECRET': secret(),
    'KEY_ENCRYPTION_SECRET': secret(), 'MONGO_ROOT_USERNAME': 'crowdreply_root',
    'MONGO_ROOT_PASSWORD': mongo_password, 'REDIS_PASSWORD': redis_password,
    'DOCKER_MONGODB_URI': f'mongodb://crowdreply_root:{mongo_password}@mongo:27017/crowdreply?authSource=admin',
    'DOCKER_REDIS_URL': f'redis://:{redis_password}@redis:6379',
    'SPEND_CAP_USD': '2', 'USER_KEY_TTL_SECONDS': '3600',
}
fd = os.open('.env', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as stream:
    stream.write(''.join(f'{key}={value}\n' for key, value in values.items()))
print('Created .env with mode 600; no credentials printed.')
PY
chmod 600 .env
```

Read `OPERATOR_USERNAME` and `OPERATOR_PASSWORD` privately in `.env` to log in.
You may choose another username or strong password before first launch. Never
commit `.env`, include it in build contexts, or paste its contents into a report.
Provider keys are absent initially: all providers run Mock. Add a temporary key
in **Settings → Provider keys** (one-hour expiry), or put an approved key in its
named `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, `GEMINI_API_KEY` or
`ANTHROPIC_API_KEY` field in `.env` and recreate API/worker. Remove the field
entirely when absent; do not set it to an empty string. Google AI stays mock-only.
Persistent env keys are the fallback when a temporary dashboard key expires.
Paid admission is currently disabled for every provider until a complete enforceable billing bound is demonstrated and independently reviewed. A key and Director approval alone do not enable successful live execution. The shared cap remains $2 by default.

The production files remove blanket `env_file` injection and pass only the
explicit application settings. Dashboard receives no database or provider keys.
The API/worker still require the backend's existing credential configuration.

**What you should see:** `.env` exists with permissions `600`, and no credential
appeared in command output. Provider keys remain absent until explicitly approved.

## 7. Validate and start the release

Replace the namespace/tag below. Use the same Compose project name for every
operation; changing it selects different named volumes and can look like data loss.

```bash
cd /opt/crowdreply
export IMAGE_NAMESPACE=owner/repository
export IMAGE_TAG=v0.1.0
sudo env IMAGE_NAMESPACE="$IMAGE_NAMESPACE" IMAGE_TAG="$IMAGE_TAG" docker compose --project-name crowdreply --env-file .env -f docker-compose.yml -f docker-compose.prod.yml config -q
sudo bash ops/deploy.sh "$IMAGE_NAMESPACE" "$IMAGE_TAG"
sudo env IMAGE_NAMESPACE="$IMAGE_NAMESPACE" IMAGE_TAG="$IMAGE_TAG" docker compose --project-name crowdreply --env-file .env -f docker-compose.yml -f docker-compose.prod.yml ps
curl --fail --head https://visibility.example.xyz/login
```

Open `https://visibility.example.xyz/login`, sign in, submit a question, and inspect
its execution and raw response. The verified path is Mock without keys. Adding a key configures access but paid admission remains disabled pending the billing-bound gate.
The API is reachable inside the Docker network, not at a public host port.
For an optional public API, uncomment its block in `ops/Caddyfile`, verify its
DNS, then restart Caddy. API-key authentication remains required.

**What you should see:** all six services are healthy, HTTPS has a trusted
certificate, login works, and a submitted mock execution completes. Caddy's
container health verifies its internal listener; the external curl/login check
is still required to prove DNS, TLS and routing.

## 8. Update, roll back, inspect and stop safely

Take a backup and retain the previous release files before updating. Apply only
backward-compatible schema/config changes if you need automatic image rollback.
Deploying code that makes irreversible data changes needs a separate migration
and recovery plan. Keep Mongo, Redis and Caddy maintenance separate from routine
application updates; their major image tags are not immutable digests.

```bash
sudo bash ops/backup-mongo.sh
sudo bash ops/deploy.sh owner/repository v0.1.1
# Deliberate rollback uses the same guarded path:
sudo bash ops/deploy.sh owner/repository v0.1.0
```

The deploy script serializes deployment/backup operations, validates tags, captures
the actual existing application tag, pulls target and rollback images before any
replacement, and runs `up -d --no-build --pull never --wait`. It waits for every
service health check, including Caddy. Failure restores the previous application
tag and checks health again. A first deployment has no rollback target. A crash
can leave `/var/lib/crowdreply/pending-release`; reconcile its recorded tags with
container status before continuing. Rollback restores image tags, **not** changed
Compose/Caddy files or data; retain the prior release configuration separately.

For logs and service operations, first set `IMAGE_NAMESPACE` and the currently
running `IMAGE_TAG`, then use this shell helper (never source `.env`):

```bash
dc() { sudo env IMAGE_NAMESPACE="$IMAGE_NAMESPACE" IMAGE_TAG="$IMAGE_TAG" docker compose --project-name crowdreply --env-file .env -f docker-compose.yml -f docker-compose.prod.yml "$@"; }
dc logs --tail=100 api worker dashboard caddy
dc restart worker
dc ps
# Maintenance stop, preserving every volume:
dc stop
# Resume the same release:
dc up -d --no-build --pull never --wait --wait-timeout 240
```

Never run a volume-removing down command on production. Do not run plain
`docker compose up` here: that omits the production security overrides.

**What you should see:** updates finish healthy or the previous application tag is
restored. Logs rotate at 10 MB × 5 files per service; persistent data remains intact.

## 9. Schedule and test backups

`ops/backup-mongo.sh` writes a compressed, checksummed logical archive under
`/var/backups/crowdreply`, restricts access, and retains completed files for 14 days.
It does not print the database password or pass it on command-line arguments.
Add this with `sudo crontab -e` after a successful manual run:

```cron
0 2 * * * /bin/bash /opt/crowdreply/ops/backup-mongo.sh >> /var/log/crowdreply-backup.log 2>&1
```

Configure host logrotate for that log. Monitor cron failures; a lock collision
returns failure and must be retried. Copy backups to an encrypted off-host
destination using the Director's chosen backup service; this repository does not
configure or verify that destination. A local-only backup does not survive VPS loss.
Follow `ops/restore-mongo.md` for an isolated restore drill and an incident restore.
The standalone Mongo logical dump is not an atomic point-in-time snapshot while
writers are active. For a consistent maintenance backup, stop API and worker
gracefully, run the backup, then restart them. Redis has no data requiring backup:
its queues recover from Mongo, and temporary provider keys intentionally expire
or disappear after restart.

**What you should see:** a nonempty archive and checksum exist, checksum/gzip tests
pass, and the isolated restore drill succeeds. Until the drill has run, record
restore verification as **not verified**, not as a tested recovery guarantee.

## 10. Rotate secrets and check production exposure

- Change `OPERATOR_PASSWORD` in `.env`, then recreate dashboard/API/worker.
  Rotate `SESSION_SECRET` too when existing signed sessions must be invalidated.
- Changing `SESSION_SECRET` signs everyone out after services restart. Keep it
  consistent between services; avoid a partially updated rollout.
- Changing `KEY_ENCRYPTION_SECRET` makes existing Redis-stored provider keys
  unreadable. Remove temporary keys using the UI before rotation, recreate
  API/worker, then re-add approved keys. Env provider keys are not encrypted there.
- Rotate `OPERATOR_API_KEY` across dashboard/API/worker together. Database password
  rotation additionally requires changing the Mongo user password: editing
  `MONGO_INITDB_ROOT_PASSWORD` does not reset an existing persisted database user.
- Confirm Mongo/Redis/API/dashboard have **no host port bindings**, check UFW and
  hosting firewall rules, `.env` mode 600, SSH key-only login, fail2ban, time sync,
  resource use, log rotation, backup age and off-host copies. Docker administrators
  can inspect container environment; restrict root/Docker access.

**What you should see:** only SSH and Caddy are publicly reachable and the new
credentials work. Expired sessions and removed temporary provider keys stop working.

## 11. Watch the first 24 hours and respond to failures

At launch, after one hour, and the next morning, inspect service health and logs,
queue depth/age, stuck executions, extraction failures, provider availability,
spend versus cap, latency, CPU/memory, disk space (`df -h`), and backup age. Sample
raw answers, citations and brand extraction for accuracy. Queue telemetry and
alert routing are operator work; this runbook does not claim a monitoring service
has been installed. Complete the 100-question validation gate before scaling.

| Symptom                                          | Immediate action                                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Public TLS/login fails                           | Check DNS/AAAA, ports 80/443, Caddy logs, dashboard health; do not expose backend ports as a workaround.                    |
| Worker backlog or extraction failure             | Inspect worker/Mongo/Redis health and sanitized logs; retain raw data and investigate before forcing a paid rerun.          |
| Spend unknown, cap reached, or `unknown_outcome` | Stop new live work; reconcile provider charges and saved data. Never automatically repeat a possibly paid call.             |
| Mongo unhealthy                                  | Preserve the volume; check disk and kernel advisory, then follow the isolated restore procedure if recovery is necessary.   |
| New release fails                                | Confirm automatic rollback health; if it fails, preserve logs and use the last known compatible configuration/tag.          |
| Secret exposed                                   | Remove/revoke provider key, rotate affected credentials and sessions, inspect access; keep values out of incident messages. |
| Disk near full / backup missing                  | Stop growth, inspect rotated logs/backups, verify off-host copies; never delete the active Mongo volume.                    |

**What you should see:** failures are investigated, spend remains understood,
and a successful backup/restore drill is recorded before increasing traffic.

## 12. Optional CD, disabled by default

There is no automatic remote deployment job in this repository. After manual
deployment and rollback have been verified, the Director may add a manually
triggered protected-environment GitHub Actions job. Its secrets are `DEPLOY_HOST`,
`DEPLOY_USER`, and `DEPLOY_SSH_KEY` (names only). Pin the SSH host key through an
independently verified known-hosts value; never disable host verification. Allow
only approved immutable tags and invoke the guarded deployment script. Grant
only the required deployment permissions and keep approval on the environment.

**What you should see:** no remote action runs automatically until the Director
explicitly adds and approves that workflow.
