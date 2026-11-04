# Engineering decisions

## Security remediation — 2026-11-03

- Replace fast SHA-256 password comparison with Node's built-in asynchronous
  scrypt and a fresh random salt, using an OWASP-listed work factor. Keep existing
  environment credential configuration and signed sessions; do not reset secrets.
- Compare API-key bytes with timingSafeEqual after checking their lengths. API
  tokens are not password hashes; avoid an expensive password KDF on every API
  request. Never accept an empty configured key.
- Upgrade development-only minimatch dependencies to pinned 11.0.4 for
  GHSA-g3hv-75wg-m249. The current ESLint/Next plugin dependency ranges do not
  provide the patched version; compatible overrides require validation of lint,
  tests, builds and clean installation. No application dependency is added.
- Dashboard's six legacy consumers need scoped file overrides because npm
  resolves override paths relative to each consuming package. Keep the pinned
  lockfile layout and clean-install regression checks. The adapter preserves
  callable matching and the test-only makeRe surface used by the import plugin;
  the patched upstream engine owns all matching. No lifecycle patches or alert
  suppressions are used. Docker copies adapter source before dependency install.
- Fresh review found trailing-NUL equivalence in scrypt's underlying HMAC.
  Reject NULs and malformed UTF-16 before derivation; retain valid Unicode.
