# AI visibility monitor

Submit buyer questions, collect independent provider answers, and inspect their raw evidence, cited domains, latency, usage and estimated cost. Each execution retains its actual **Live** or **Mock** provenance. This assessment build supplies an operator dashboard, an authenticated API, durable execution storage, provider queues, transient encrypted keys, Docker configuration and CI/release workflows.

## Architecture

```text
Browser -- signed httpOnly session --> Next.js dashboard
Dashboard server -- x-api-key --> Express API
API --> MongoDB execution identity + raw responses + live spend ledger
API --> Redis / BullMQ (one queue per provider) --> provider workers
Worker --> resolve temporary key -> environment key -> Mock
Worker --> provider response --> durable raw record --> succeeded
                                                  --> extraction queue --> versioned brands
```

MongoDB is authoritative; Redis is transport. A unique execution key and atomic claim prevent duplicate provider work. A separate extraction queue processes stored raw answers using the rule-based extractor. Versioned results preserve written aliases, recommendation ranks, mention counts, ambiguity, spans and supported citation links. Extraction errors never change provider success or repeat a provider request. The optional paid LLM extractor is not enabled.

## Run locally with Docker

Requirements: Docker Engine/Desktop with Compose 2.24+; Node 24+ and npm for host checks. Local Docker was authorized for this handoff. No provider keys are needed to inspect the application.

1. Keep the root `.env` private (`chmod 600 .env`). The handoff creates it locally from `.env.example` with random credentials and no provider keys. If creating a new environment, copy `.env.example` to `.env`, replace every credential placeholder privately with independently generated random values, and keep Mongo/Redis URI credentials consistent. Percent-encode URI credentials. `.env` is ignored and excluded from Docker contexts. Never print expanded Compose configuration.
2. From the repository root, start or rebuild the five services:

   ```sh
    docker compose up -d --build
    docker compose ps
   ```

   Wait for Mongo, Redis, API, worker and dashboard to show `healthy`.

   All five services use `restart: unless-stopped`, including Mongo and Redis.
   After explicitly stopping containers, use the full Compose start command above
   to bring their dependencies back too; restarting only API/worker cannot start
   stopped dependencies.

3. Open the [dashboard](http://127.0.0.1:3001). Read the login values privately from `.env`: `OPERATOR_USERNAME` and `OPERATOR_PASSWORD`. The [API readiness endpoint](http://127.0.0.1:3000/health/ready) is public; other API routes require the `OPERATOR_API_KEY` field as the `x-api-key` header. Mongo and Redis ports bind only to loopback.
4. Choose **Submit question**, enter a buyer question, choose a provider and submit. Open **Executions** and select the result to inspect the raw answer, citations, extracted brands and version history. **Visibility** defaults to live data only; enable **Include Mock** explicitly to inspect synthetic brand shares. **Mock** means deterministic synthetic evidence with no provider call or live spend; **Live** means the execution actually used a provider key. Google AI search is always Mock and is separate from Gemini. Existing executions retain their original mode.
5. To enable a supported provider, open **Settings → Provider keys**, choose the provider and add its key. The encrypted server-side key expires after one hour. Removing it returns to the environment key, or Mock when none exists. Adding a key configures live access, but production paid admission currently fails closed: the researched APIs do not supply a proven complete billing bound. No live provider call was made during this handoff. Resolve the documented billing-bound gate before enabling paid work.
6. Inspect logs or stop the stack:

   ```sh
    docker compose logs --tail=100 api worker dashboard
    docker compose down
   ```

   A deliberate **all-data reset** removes the Mongo volume and its executions:

   ```sh
   docker compose down -v
   ```

   This reset was not run.

The local Mongo service sets `GLIBC_TUNABLES=glibc.pthread.rseq=1` to avoid the documented MongoDB 8 TCMalloc crash on Docker Desktop kernel `7.0.12-linuxkit`. The production override removes this local workaround; use a supported fixed kernel and verify Mongo health. See [deployment kernel guidance](DEPLOYMENT.md#2-prepare-and-harden-the-server).

Production session cookies retain `HttpOnly`, `SameSite=Strict` and `Secure`. Use the exact loopback URL above with a browser that supports Secure cookies on trustworthy loopback origins; HTTPS is required for non-loopback deployments. Never disable production cookie security to work around HTTP browser behavior.

For host development, start Mongo/Redis with `docker compose up -d mongo redis`, then run `npm run dev`, `npm run worker:dev` and `npm --prefix dashboard run dev` in separate terminals. Install dependencies first with `npm ci` and `npm --prefix dashboard ci`. Root `.env` URLs use loopback; Docker uses `DOCKER_MONGODB_URI` and `DOCKER_REDIS_URL` service names. Never target an unintended production database.

## Provider modes and temporary keys

| Provider           | Live adapter                                             | No key |
| ------------------ | -------------------------------------------------------- | ------ |
| ChatGPT / OpenAI   | Responses API + web search                               | Mock   |
| Perplexity         | Agent API + search results                               | Mock   |
| Gemini             | generateContent + search grounding                       | Mock   |
| Anthropic / Claude | Messages API + server web search                         | Mock   |
| Google AI search   | No supported API; always mock-only, distinct from Gemini | Mock   |

At attempt time, an encrypted dashboard-added key wins over the environment key, then the provider falls back to Mock. Temporary keys use AES-256-GCM with randomized IVs, a server-only encryption secret and a maximum one-hour TTL. Overwriting resets TTL; removal returns to the environment key or Mock. Redis snapshots/AOF are disabled so these keys never persist to disk. Do not add persistence or unreviewed backups for this Redis service.

Execution mode is stored on its first attempt and never changed during a retry. Changing credentials does not turn an old mock into live evidence. Deliberately rerun if a new mode is needed. Mock raw data has `mock:true`, null token usage and zero cost; it is excluded from live spending and live counts. Overview counts are explicitly a bounded recent-100 sample, not global historical analytics.

## Reliability and spend

- Raw data is upserted before `succeeded`; failure cannot trigger an extraction-driven repeat of a paid request.
- Retry scheduling/backoff lives in MongoDB; BullMQ transports delayed work without an independent retry policy.
- Recovery restores queued/due work after Redis loss. Expired possibly paid attempts become `unknown_outcome`; they never auto-retry.
- A global Mongo live-call gate serializes budget decisions. Wholly rejected HTTP errors settle to zero; partial paid chains retain their reservation. No-response outcomes or expired leases use their persisted admitted reservation before an owner gate is released. Numeric amounts are immutable on replay. Legacy attempts without a proven stored reservation remain genuinely unknown and fail closed; a planning estimate alone is not settlement evidence.
- Pre-call reservations use configured/researched cost estimates; actual billing can differ. Confirm model prices, search limits and reserve bounds before enabling paid work. A provider-side account spending limit is needed for an independently enforced billing ceiling.
- The Anthropic default is the researched priced `claude-sonnet-5-5`. Production live admission nevertheless remains closed for every provider: output/tool caps do not establish a complete billable-input/search upper bound. Tests inject a deterministic synthetic bound only for fake calls; there is no production environment bypass. Director-approved provider/account limits and fresh review are required before any paid run.
- Authentication/credit/budget failures pause only the affected provider queue. An operator must reconcile the cause and explicitly resume that queue; a public queue-resume endpoint is not included.

### Timeouts

A live timeout, abort or network failure without an HTTP response is deliberately `unknown_outcome`, never auto-retried, because the provider may already have charged for the request. The existing attempt ledger uses its persisted admitted reservation. Other executions may continue under a known remaining cap. A legacy attempt without actual settlement or a proven stored reservation stays unknown and requires reconciliation. An expired live crash follows the same accounting before recovery releases only that execution’s gate.

## Commands

| Root command                                                            | Purpose                                                                    |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `npm run check`                                                         | Lint, scoped formatting, source/test typecheck, all offline unit/E2E tests |
| `npm run build` / `npm run start`                                       | Compile/start API                                                          |
| `npm run dev`                                                           | Host API watch mode                                                        |
| `npm run worker` / `npm run worker:dev`                                 | Production/watch worker                                                    |
| `npm run typecheck`                                                     | Strict source and test compilation                                         |
| `npm run test:unit`                                                     | All default offline tests; real-service suites skipped                     |
| `npm run test:idempotency`                                              | Repository/worker/API/E2E identity checks                                  |
| `npm run test:retry` / `npm run test:failure`                           | Focused retry/failure suites                                               |
| `npm run test:integration`                                              | Explicit real Mongo integration opt-in; requires configured local services |
| `npm run test:e2e`                                                      | Explicit real Mongo/Redis E2E opt-in; requires configured local services   |
| `ALLOW_LIVE=1 LIVE_PROVIDER=openai npm run live:check`                  | One budget-gated real question; never an automatic test                    |
| `npm run format` / `npm run format:check`                               | Apply/check formatting within owned source paths                           |
| `npm --prefix dashboard run check` / `npm --prefix dashboard run build` | Dashboard validation/build                                                 |

The default root Vitest config discovers `tests/**/*.test.ts`. Every test script uses it; no alternate test config is required. Contracts may evolve through tested backwards-compatible changes recorded in DECISIONS.md; unchanged foundation files remain excluded from automatic formatting. Read [dashboard guide](dashboard/README.md) for its commands and UI rules.

## Extraction and visibility

Raw provider success is independent of extraction. The separate `extraction` BullMQ queue uses durable Mongo work rows, fenced leases and bounded retries. Recovery repairs missing jobs after transport loss. Reprocessing uses a caller-supplied idempotency key: the same key returns the same version; a new key adds history without repeating provider work or overwriting terminal results.

- `GET /executions/:id` includes the current extraction summary.
- `GET /executions/:id/extraction` returns the current version and up to 20 history rows.
- `POST /executions/:id/extraction/reprocess` accepts `{"idempotencyKey":"YOUR_UNIQUE_REQUEST_ID"}`. An existing key returns 200; a new request returns 202. Raw retention expiry prevents reprocessing and is reported explicitly.
- `GET /visibility?from=YYYY-MM-DD&to=YYYY-MM-DD&provider=openai&includeMock=false` aggregates only current completed versions. Dates are real UTC dates, at most 366 days; provider is optional. Mock is excluded by default, and explicit inclusion reports provenance and execution counts.

Visibility share is eligible unambiguous mention count divided by all eligible mentions for that provider and integration. It is not a performance score. Unknown ranks are excluded from the average rather than treated as zero. Ambiguous mentions remain visible on detail pages and are excluded from analytics. Citation links are attached only with supporting evidence; all original citations remain preserved.

The assessment CRM example is a labeled fixture, not a provider result. Mock answers are synthetic. The implemented rule approach is an explicit trade-off from the original structured-JSON LLM design; paid extraction requires separately reviewed billing/reconciliation support.

## Project structure

```text
src/contracts  validated schemas, types and repository/provider seams
src/config     validated server configuration and presence-only diagnostics
src/logging    redaction and correlation middleware
src/health     liveness and injectable bounded readiness
src/keys       encrypted Redis key store and access resolver
src/db         execution/extraction repositories, indexes, raw storage and ledger
src/extraction rule-based open brand discovery, aliases and reprocessing service
src/providers  four live adapters, five deterministic mock paths, opt-in verifier
src/queue      independent provider queues and a separate extraction queue
src/workers    provider/extraction processing, fenced claims, backoff and recovery
src/api        constant-time API auth, validation and safe projections
src/server.ts  API/runtime wiring
src/worker.ts  workers, recovery and explicit single-call verifier
dashboard/    separate Next.js operator application
tests/        synthetic/fake-driver unit tests and opt-in integration/E2E suites
.github/      CI and tag-triggered image release workflows
```

## CI/CD and operational checks

CI validates both packages, builds images without pushing, validates Compose and audits dependencies. Version tags `v*` build/push API and dashboard images to GHCR with the repository token and minimal permissions. Release publishing depends on reusable CI validation for the same tagged commit. Deployment is a separate Director-run operation, documented in DEPLOYMENT.md; no remote deploy step was enabled. GitHub workflows/actions and release publishing remain unverified until run there. Local handoff verification built both application images and ran the five-service stack with authenticated Mongo/Redis; no live provider was called.

Before production: require real-service integration, restore/load evidence, authentication/security review, alert routing, runbooks and Director approval. Monitor queue age, provider errors, raw/extraction gaps, average/p95 latency, spend and unknown outcomes. Start with the approved 100-question/five-provider validation cohort only after legitimate live access, limits and quality/cost thresholds are confirmed.

## Known limitations and first-live verification

- No live provider was called; synthetic success does not prove a current model ID, API response shape, quota or price. Confirm all four model IDs against the configured account.
- OpenAI: confirm auth, search-source shape, completion statuses, citation offset units and actual search billing. Search output is not reproducible.
- Perplexity: confirm Agent API field names, cost metadata, account routing and terms for this use.
- Gemini: confirm `googleSearch`, grounding/domain metadata, byte offsets, search query billing and quota. The provided research says 10,000/day needs a quota increase.
- Anthropic: confirm the version-header conflict, default model price, 200 search errors and bounded continuation behavior.
- Google AI search remains mock-only. It is never backed by Gemini or an unapproved scraping source.
- GitHub CI execution, registry publishing, remote deployment and load capacity remain unverified. Local image builds, Node 24 runtime, authenticated Mongo/Redis integration/E2E and an isolated Mongo dump/restore drill passed. See REVIEW_LOG.md for failure/recovery evidence and remaining boundaries.
- Force reruns use a process-local monotonically increasing sequence; use one API replica until a shared atomic rerun counter is approved.
- Rule-based extraction and version history are implemented. Paid LLM extraction and a detailed provider attempt-history UI are not implemented. Daily scheduling remains designed, not built.
- IBM Plex/OFL files were unavailable under the no-download constraint. The dashboard uses a documented system-font fallback. Next.js 16 route gating uses the current `proxy.ts` convention.
- Unit UI fixtures remain synthetic. The handoff also checks the real local Docker dashboard against the API using Mock executions; this does not validate any live provider.
- Standard React/ReactDOM/Node type packages were necessary for strict dashboard compilation. The root compiler is aligned to TypeScript 6.0.3 because the approved typescript-eslint version rejects TypeScript 7's peer range.
