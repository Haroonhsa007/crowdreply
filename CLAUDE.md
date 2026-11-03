# Project collaboration rules

## Authority
- Technical ownership transferred from Claude Code to Codex on 2026-11-02.
- Claude Code gathered requirements, led architecture and reviewed earlier work.
- Codex now leads implementation and coordinates separate fresh review sessions.
- The Director owns scope, business-impacting architecture, legal questions,
  spending, git operations and release. Follow tasks/CODEX-HANDOFF.md.
- Preserve historical task documents as evidence; use current project rules.

## Product and architecture
- AI visibility monitor: target 10,000 buyer questions × five providers per day.
- TypeScript/Node/Express, Next.js/React/Tailwind, MongoDB, Redis/BullMQ.
- Dashboard is in scope; its API calls are server-side, never exposing API keys.
- Four providers support Live with a key and Mock otherwise. Google AI search
  stays Mock-only; Gemini is a separate provider, never AI Overviews.
- Show actual execution provenance. Unknown usage/cost is null.
- Save full raw answers/citations first, then separate extraction.
- Normalize aliases, preserve recommendation order and flag ambiguity.
- Extraction failure cannot change provider success or repeat paid provider work.
- Mongo unique executionKey controls idempotency; dead-letter is a Mongo status.
- Redis persistence is off; encrypted user keys expire after one hour.
- Live timeout/no-response is unknown_outcome, reserved and never auto-retried.
- Daily scheduling is designed but not built; do not claim daily automation.

## Safety and quality
- No git commands, commits, pushes, worktrees or merges; Director handles git.
- Local Docker is approved. No remote server/DNS actions or provider calls
  during handoff. live:check is for the Director only.
- Credentials go only in ignored .env; never print, log, screenshot or embed
  values in source, tests, prompts, URLs, reports or browser assets.
- Never present Mock as Live, plans as deployment, or skipped checks as passed.
- Strict types, validated inputs/outputs, small modules and sanitized logs.
- No any, console.log, dead code, swallowed failures or weakened assertions.
- Record small backwards-compatible contract changes and dependencies in DECISIONS.md.

## Delegation and review
- Bounded self-contained briefs state files, prohibitions and deliverables.
- Parallel tasks require independent work with disjoint write ownership.
- Luna medium/high reads; Sol medium/high implements; Astra medium/high plans
  and implements. Report only model/effort confirmed by runtime.
- Significant changes require a separate fresh read-only codex exec session.
- Inspect actual code; record findings, fixes and retests in REVIEW_LOG.md.
- Resolve CRITICAL/HIGH/MEDIUM findings before phase completion.

## Verified script names
- Root: npm run check; npm run build; npm run typecheck; npm run test:unit.
- Focused: npm run test:idempotency; npm run test:retry; npm run test:failure.
- With local Mongo/Redis: npm run test:integration; npm run test:e2e.
- API: npm run dev / start; worker: npm run worker:dev / worker.
- Dashboard: npm --prefix dashboard run check / build / dev.
- Stack: docker compose up -d --build; docker compose ps; docker compose logs.
- Stop: docker compose down. Deliberate reset: docker compose down -v.
- Keep .env private and never print expanded compose configuration.
