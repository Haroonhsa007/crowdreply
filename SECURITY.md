# Security policy

## Supported version

Security fixes target the current `main` branch of CrowdReply (package version
`0.1.0`). Older commits and deployments must be updated to receive fixes. This
project has no supported 4.x or 5.x release series.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Haroonhsa007/crowdreply/security/advisories/new)
when available. If reporting is disabled, contact the repository owner privately
through their GitHub profile to arrange a secure channel. Do not disclose an
exploit, passwords, API keys, session cookies or customer data in a public issue.
Include the affected version, impact, reproduction steps using synthetic data,
and suggested remediation. Maintainer response times are not guaranteed; agree
on disclosure timing privately after the report is acknowledged.

## Authentication and secrets

- Operator credentials remain server-only environment configuration. Protect
  `.env` and the deployment's secret store; changing comparison algorithms does
  not encrypt an environment file or migrate credentials to a user database.
- Password verification uses asynchronous Node.js scrypt with a fresh 16-byte
  random salt and 32-byte output: `N=16384`, `r=8`, `p=5`, `maxmem=32 MiB`.
  This is an [OWASP-listed scrypt work factor](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
  Both derived values use the same per-verification salt and are compared with
  `timingSafeEqual`. Verification does not log credentials or persist derived
  verifiers.
- Credential fields are not trimmed or case-normalized. Empty fields and inputs
  exceeding 1024 UTF-16 code units, embedded NULs, and unpaired UTF-16
  surrogates fail closed before expensive derivation. Valid Unicode remains
  supported; these guards prevent encoding and scrypt padding aliases.
  A process-local single-flight gate bounds scrypt work. Five failed logins
  trigger the existing five-minute cooldown. This limiter is per process and
  resets on restart; use shared rate limiting before scaling login replicas.
- API tokens use a byte-length guard followed by `timingSafeEqual`, without a
  password hash or expensive KDF on each API request. The length check is not
  constant time; token length is not treated as secret. Empty configured tokens
  fail closed. Generate high-entropy tokens; do not reuse a human password.
- Signed session cookies are HttpOnly, SameSite=Strict, and Secure in production.
  Use HTTPS for remote deployments. The browser never receives operator API
  keys or provider credentials. Rotate exposed credentials immediately.
- Temporary provider keys remain server-side, encrypted and expire after one
  hour. Redis persistence stays disabled. Never include secrets in logs, URLs,
  screenshots, test fixtures or error reports.

## Dependency remediation

The November 2026 remediation replaces SHA-256 credential comparisons reported
by CodeQL `js/insufficient-password-hash` in API authentication and dashboard
login. It also updates the actual minimatch matcher to `11.0.4` in both npm
lockfiles for [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)
(the advisory's first fixed version is `11.0.1`).

Root lint tooling uses a pinned npm override. Dashboard legacy lint plugins
require the older callable CommonJS API, so a small development-only local
adapter exposes the patched package through that interface, including the
`makeRe(...).test(path)` behavior used by the import lint plugin. It contains no
copied matcher implementation and runs no installation hooks. The dashboard
`.npmrc` installs this local adapter as a self-contained package; scoped relative
overrides and the lockfile layout are covered by clean-install consumer tests.
Overrides and lockfiles must be maintained together; remove the adapter when all consumers
support the patched API directly. Do not suppress alerts or disable lint rules
to work around a vulnerable dependency.

## Verification and limits

Before release run the root and dashboard `npm run check` and `npm run build`,
`npm audit` in both directories, and the integration/E2E suites with local Mongo
and Redis. Verify failed and successful sign-in, unauthorized API rejection and
healthy services after rebuilding Docker. Tests use Mock providers and do not
prove live-provider billing or production security.

Local checks cannot close GitHub alerts. The repository owner must publish the
changes and rerun CodeQL and Dependabot analysis on the affected branch. Confirm
that all reported alerts close on that commit; do not mark an alert resolved
solely because a local test passed.
