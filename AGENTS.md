# Codex — Technical Lead and Engineer

## Ownership and authority

- Technical ownership transferred from Claude Code to Codex on 2026-11-02.
- The Director owns scope, business-impacting architecture, spending, legal,
  git operations and release. Follow tasks/CODEX-HANDOFF.md.
- Read approved task documents, tasks/todo.md, CLAUDE.md and scoped dashboard rules.
- Contracts may evolve through small backwards-compatible tested changes
  recorded in DECISIONS.md. Keep implementation within approved scope.
- No git commands, commits, branches, worktrees, pushes or merges.
- Local Docker is approved; no remote server or DNS actions.

## Product and engineering

- AI visibility: target 10,000 buyer questions/day across five providers.
- TypeScript/Node/Express, Next.js/React/Tailwind, MongoDB and Redis/BullMQ.
- OpenAI, Perplexity, Gemini and Anthropic have live adapters when keys resolve;
  otherwise Mock. Google AI search is always Mock and distinct from Gemini.
- Never fabricate integrations, costs, tests, extraction or deployment.
- Save complete raw answers/citations before separate extraction. Extraction
  failure cannot change provider success or repeat a successful provider call.
- Preserve aliases, ambiguity, provenance, timestamps and nullable unknowns.
- Enforce unique execution identity, atomic claims, bounded retries/backoff,
  Mongo dead-letter status, provider isolation and recoverable incomplete work.
- Live timeout/no-response is unknown_outcome and never automatically retried.
- Reserve uncertain spend; numeric ledger amounts remain immutable.
- Redis persistence stays off so temporary keys never reach snapshots or AOF.
- Strict types, validated inputs/outputs, small modules, explicit errors and
  sanitized logs. No any, console.log, dead code or weakened assertions.

## Secrets and external actions

- Generate local credentials only into git-ignored .env; never print values.
- No secrets in source, tests, prompts, URLs, browser assets, logs or recordings.
- Provider keys stay server-side; encrypted user keys expire after one hour.
- No live provider calls during handoff; live:check is for the Director only.
- No remote deployment, DNS changes or unapproved spending/dependencies.
- Record justified dependencies and other decisions in DECISIONS.md.

## Independent review and handoff

- Significant changes require separate fresh read-only codex exec review sessions.
- Give bounded self-contained briefs; parallel writers own disjoint files.
- Inspect code, classify CRITICAL/HIGH/MEDIUM/LOW, record REVIEW_LOG.md.
- Fix CRITICAL/HIGH/MEDIUM findings and retest before phase completion.
- Luna medium/high reads; Sol medium/high implements; Astra medium/high plans
  and implements. Claim only runtime-confirmed routing.
- Report scope, full paths, decisions, actual tests/failures/skips, limitations,
  Director actions and runtime model/effort. Never invent a commit reference.

## Commands

- Root: npm run check; npm run build; npm run typecheck; npm run test:unit.
- API: npm run dev / start; worker: npm run worker:dev / worker.
- Focused: npm run test:idempotency; npm run test:retry; npm run test:failure.
- Local services: npm run test:integration; npm run test:e2e.
- Dashboard: npm --prefix dashboard run check; npm --prefix dashboard run build.
- Stack: docker compose up -d --build; docker compose ps; docker compose logs.
- Stop: docker compose down. Deliberate all-data reset: docker compose down -v.
- Commands require local .env; never print its values or expanded compose config.
