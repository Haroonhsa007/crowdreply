# Dashboard Agent Guidelines — AI Visibility Platform

These rules apply to everything under `dashboard/`. They supplement the root `AGENTS.md` and `CLAUDE.md`. Technical ownership transferred to Codex on 2026-11-02; the Director retains release, legal and spending authority. When rules conflict, follow the safer or more specific one.

The dashboard is the **operator interface** for the AI Visibility Platform. Operators use it to submit buyer questions, watch executions run through the queue, and inspect what each AI provider answered, which pages it cited, what it cost and how long it took.

It is an operations tool, not a marketing site or a generic SaaS template. Favor clarity, density and honesty over decoration.

---

## 1. Stack and boundaries

- Next.js **App Router**, React, strict TypeScript, Tailwind CSS. One app, in `dashboard/`, with its own `package.json`.
- The Express API in `../src` is a separate service. The dashboard talks to it only through the typed server-side client in `src/lib/api/`.
- **Do not introduce**: React Router, Vite, a second frontend framework, Redux, Axios, Socket.IO, an icon library, a chart library, or a UI kit. They are not needed for this scope. Plain React state, URL state and server components are enough.
- **Approved dependencies** (anything else must be justified in DECISIONS.md first): `next`, `react`, `react-dom`, `tailwindcss` (with the official PostCSS integration for the installed major), `typescript`, `zod`, `vitest`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `eslint` with `eslint-config-next`, `prettier`. Pin exact versions and list them in your report.
- Never change backend behavior. If the dashboard needs a different API contract, stop and report it to Claude Code. Do not edit `../src`.

---

## 2. Trust boundary and authentication (most important rule)

The browser must **never** receive the API key, session secret, operator password, database credentials or provider keys.

```
Browser  ──cookie──▶  Next.js server  ──x-api-key──▶  Express API ──▶ MongoDB / Redis
 (no secrets)         (holds secrets, server-only)
```

- All API calls happen on the Next.js server (Server Components, Server Actions, Route Handlers). Client Components never call the API directly and never import server-only modules.
- Secrets are read only in server-only modules (`import 'server-only'`) and validated with zod at startup in `src/lib/env.ts`. Fail fast with a message that names the field, never the value.
- `NEXT_PUBLIC_*` is not secret storage. Do not use it for anything sensitive.
- **Login:** username and password come from `OPERATOR_USERNAME` and `OPERATOR_PASSWORD`. Compare in constant time. On success set a signed session cookie (`SESSION_SECRET`): `HttpOnly`, `SameSite=Strict`, `Secure` in production, short expiry. Provide logout. Slow down repeated failed logins (a simple in-memory delay or lockout is fine for one operator).
- **Protect every route** except `/login` (and static assets) with the installed Next.js proxy convention. An unauthenticated visitor is redirected to `/login?next=<path>`; never left on a spinner. Render three distinct states: checking, unauthenticated (redirect), authenticated.
- **Safe redirects:** `next` must pass `safeNextPath()`. Reject anything that is not a same-origin relative path: values starting with `//`, containing a backslash (`/\evil.com` resolves to an external host), containing a scheme, or pointing at `/login`. Unit-test these cases.
- State-changing actions (submit, logout) use Server Actions or same-origin-checked Route Handlers.
- Add basic security headers in `next.config` (`X-Content-Type-Options: nosniff`, `Referrer-Policy`, `frame-ancestors 'none'` / `X-Frame-Options: DENY`).
- Never put credentials, tokens or keys in source, fixtures, tests, screenshots, logs, URLs, `localStorage`, `sessionStorage` or error messages. Test fixtures use obviously fake placeholder values.

---

## 3. Folder structure

Feature-based. A feature owns its route, its components and its behavior.

```
dashboard/
├── AGENTS.md
├── README.md                    quick start, env, scripts, Docker (keep current)
├── Dockerfile
├── package.json, tsconfig.json, next.config.ts, eslint/prettier config
├── src/
│   ├── proxy.ts                 auth gate
│   ├── app/
│   │   ├── layout.tsx, globals.css
│   │   ├── login/               page.tsx, login-form.tsx, actions.ts
│   │   └── (console)/           authenticated shell: layout.tsx with navigation
│   │       ├── page.tsx                 overview
│   │       ├── executions/
│   │       │   ├── page.tsx             list (filters + pagination in URL)
│   │       │   ├── components/          execution-table, execution-filters, status chips
│   │       │   ├── new/                 submit-question form + server action
│   │       │   └── [id]/page.tsx        execution detail
│   │       └── providers/               integration status per provider
│   ├── components/              shared primitives used by 2+ features
│   ├── lib/
│   │   ├── api/                 typed server-side API client (one module per resource)
│   │   ├── auth/                session, password check, safe-next-path
│   │   ├── format/              duration, cost, number, timestamp formatters
│   │   └── env.ts
│   └── types/                   dashboard-only types (API types come from contracts)
└── tests/                       mirrors src/
```

- Keep `page.tsx` thin: read route params, fetch page data, compose feature components, own `loading.tsx` and `error.tsx`. No business workflows in pages.
- Move a component to `src/components/` only when two or more features use it. Do not create `helpers/`, `common/` or `misc/` folders.
- Files and folders use kebab-case. Exported components use PascalCase. Prefer named exports; use default exports only where Next.js requires them. Use the `@/` alias. Avoid barrel files.
- One purpose per module. No generic utility files containing unrelated functions.
- Dependency direction: `app/` → feature components → `lib/` → nothing. No circular imports. A feature does not import another feature's internals.

---

## 4. Server and Client Components

Server Components are the default. Add `"use client"` only for browser APIs, state, effects, event handlers or client-side interaction, and keep the client boundary as small as practical (a filter control, a polling refresher, a copy button), never a whole page or layout.

---

## 5. API access and shared contracts

- One typed client in `src/lib/api/` (native `fetch`, `cache: 'no-store'` for live data). It owns the base URL (`API_BASE_URL`, server-only), the `x-api-key` header, a per-request timeout (`AbortSignal.timeout`), correlation-id forwarding (`x-correlation-id`), and a normalized `ApiError` (`status`, `code`, `requestId`, safe message).
- Parse every response with the zod schemas from the shared contracts (`ApiExecutionViewSchema`, `ApiExecutionListResponseSchema`, `ApiSubmitRequestSchema`). Never trust an unvalidated response.
- Import contract types and schemas through a single path alias to `../src/contracts`. Client Components may use `import type` only, because the contracts module includes server-only code.
- No `fetch` in components, no API URLs in components, no second HTTP client, no duplicated error handling.
- Never use `any`. Use `unknown` plus zod narrowing.

---

## 6. Data fetching, URL state and refresh

- The backend owns pagination, filtering and ordering. The dashboard never loads a full dataset to filter it in the browser. Lists use the API's bounded cursor (`limit` 1 to 100, `before`).
- State that a user may share or bookmark lives in the URL: `provider`, `status`, `before`, `limit`. Never put secrets, raw responses or long question text in a URL.
- **Auto refresh:** executions in `queued`, `running` or `retry_wait` refresh themselves every few seconds through a small Client Component that calls `router.refresh()`. Pause when the tab is hidden. Stop when every visible execution is terminal (`succeeded`, `dead`, `unknown_outcome`). Always show "Last updated <time>".
- Cancel stale requests and ignore out-of-order responses. Never let an older response overwrite newer state.
- There is no realtime socket in this build. If one is added later, an older event must never overwrite newer state, and a disconnected state must be visible to the operator.

---

## 7. Domain language and honesty rules

Use the precise terms operators need; do not rename them into vague labels.

> Execution, Provider, Model, Question, Run date (UTC), Execution key, Attempt, Retry, Dead-lettered, Raw response, Citation, Cited domain, Brand mention, Alias, Recommendation position, Extraction, Latency, Tokens, Estimated cost, Spend cap.

Truthfulness rules (these are product requirements, not style):

1. **Integration status is always visible.** Every provider shows `Live`, `Mock` or `Not integrated`. OpenAI, Perplexity, Gemini and Anthropic use `Live` only when a key resolves; otherwise `Mock`. Google AI search is always `Mock`. Never present a mock or a not-integrated provider as working. Google's AI search experience is a separate provider from Gemini.
2. **Missing citations are not failures.** A successful execution with no citations shows "Citations not available". Show "Citations unknown" when the adapter could not tell. Neither uses failure styling.
3. **Unknown is not zero.** A `null` token count, cost or latency renders as `—` with an accessible "unknown" label. Never render `0` or `$0.00` for unknown values.
4. **Provider status and extraction status are separate.** An execution can be `succeeded` while extraction is `pending` or `extraction_failed`. Show both.
5. **`unknown_outcome`** means a crash after a possibly paid call with no stored result. State this in plain words and do not offer an automatic retry.
6. **Brands and positions** appear only when extraction has run. Otherwise show "Extraction has not run for this execution". Never fabricate brands or rankings.
7. Estimated cost is an estimate. Label it as such and show spend against the configured cap.

---

## 8. Screens in scope

| Screen               | Purpose and content                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Login**            | Username and password form, clear error, no hints about which field was wrong.                                                                                                                                                                                |
| **Overview**         | Execution counts by status, spend versus the cap, provider integration table, recent failures. Strong emphasis on failures and the cap; secondary information quieter. Do not turn every metric into a card.                                                  |
| **Executions**       | Dense table: question, provider, model, status, extraction, citations, latency, cost, created. Backend pagination and filters in the URL. Skeleton, empty, no-match, error and unauthorized states.                                                           |
| **Execution detail** | Header (status, key facts, actions) first. Then the answer text, citations with normalized domains (links open safely with `rel="noopener noreferrer"`), attempt history, usage and cost, identifiers (copyable), extraction status, and brands if available. |
| **Submit question**  | Form validated with `ApiSubmitRequestSchema`. Shows the existing execution when the request is a duplicate ("already run today"). The `force` re-run option needs a confirmation that says it makes a new paid call and counts against the spend cap.         |
| **Providers**        | Table of the five providers with integration status and short capability notes.                                                                                                                                                                               |

Anything not listed is out of scope. Do not add screens speculatively.

---

## 9. Status system

Use semantic colors consistently. Color is never the only signal: always include the text label (and an icon only if it helps).

| Value                                   | Label                                         | Tone                   |
| --------------------------------------- | --------------------------------------------- | ---------------------- |
| `queued`                                | Queued                                        | neutral (slate)        |
| `running`                               | Running                                       | info (sky)             |
| `retry_wait`                            | Retrying                                      | warning (amber)        |
| `succeeded`                             | Succeeded                                     | success (emerald)      |
| `dead`                                  | Dead-lettered                                 | danger (rose)          |
| `unknown_outcome`                       | Unknown outcome                               | warning (amber)        |
| extraction `not_applicable` / `pending` | Not run / Pending                             | neutral                |
| extraction `extracting`                 | Extracting                                    | info                   |
| extraction `extracted`                  | Extracted                                     | success                |
| extraction `extraction_failed`          | Extraction failed                             | danger                 |
| integration `live`                      | Live                                          | success                |
| integration `mock`                      | Mock                                          | warning                |
| integration `not_integrated`            | Not integrated                                | neutral                |
| citations `yes` / `no` / `unknown`      | Citations available / not available / unknown | neutral (never danger) |

Implement one status-chip module per enum and a TypeScript exhaustiveness check (`satisfies Record<…>`) so adding an enum value without a label fails the build. The same status uses the same tone on every screen.

---

## 10. Design system

Tokens live in one place (`src/app/globals.css` for Tailwind v4's `@theme`, or `tailwind.config.ts` for v3; use whichever major is installed and say which in the README). Components use token names, never raw hex values.

Token groups: `brand-*`, `accent-*`, `canvas`, `surface`, `surface-2`, `surface-3`, `ink`, `text-main`, `text-muted`, `text-soft`, `ui-border`, `ui-line`, `success-*`, `warning-*`, `danger-*`, `info-*`, `skeleton-*`, `gutter`, `shadow-canvas`, `shadow-overlay`.

| Token                             | Light                                         |
| --------------------------------- | --------------------------------------------- |
| canvas                            | `#FFFFFF`                                     |
| surface                           | `#FEFEFE`                                     |
| surface-2                         | `#F5F9FD`                                     |
| surface-3                         | `#E6EDF9`                                     |
| ink / primary text                | `#142D3D`                                     |
| text-muted                        | `#607182`                                     |
| text-soft                         | `#667B88`                                     |
| ui-border                         | `#D4DFEB`                                     |
| ui-line                           | `#E6EDF5`                                     |
| brand (primary)                   | `#0264FC` (hover `#1D4ED8`, soft `#EFF6FF`)   |
| success / warning / danger / info | `#07C38B` / `#F59E0B` / `#FC4652` / `#2563EB` |
| skeleton base / highlight         | `#E6EDF5` / `#F5F9FD`                         |

- The Director’s latest request (2026-11-03) disables dark mode and supersedes the earlier dark reference. Keep the dashboard light-only regardless of `prefers-color-scheme`, with `color-scheme: light` and Cloudlet `theme="light"`. Preserve forced-colors accessibility support.
- Style: white operational surfaces, blue primary actions, restrained radius (`rounded` / `rounded-md`; no `rounded-2xl`, `rounded-3xl` or pills except status chips), shadows only for overlays (`shadow-overlay`) and major layers (`shadow-canvas`), dense layouts, clear hierarchy through type and whitespace rather than borders on everything.
- **Avoid:** gradients, glows, glassmorphism, decorative blobs, decorative icons, heavy shadows. If it does not help an operator understand or control the system, remove it.
- Icons: none by default. Use small inline SVG only where it communicates an action or state, in one consistent style.

---

## 11. Typography, numerals and identifiers

- **Typeface:** IBM Plex Sans for UI, IBM Plex Mono for identifiers, via `next/font/google` bound to `--font-sans` and `--font-mono`. Do not ship the Next.js default Geist. If the build environment has no network, use `next/font/local` with committed OFL font files instead.
- **Tabular figures are a correctness rule.** Set `font-variant-numeric: tabular-nums` on every numeric column: latency, tokens, cost, counts, durations and digit timestamps. Numbers right-align; text left-aligns.
- **Monospace is for identifiers only**: execution ID, execution key, request and correlation IDs, provider response ID, URLs and domains. Never use mono to make labels look technical.

---

## 12. Formatting

Shared formatters live in `src/lib/format/` with unit tests. Components never format inline.

- **Duration/latency:** under 1 s as `850 ms`; otherwise `m:ss` (`0:04`, `1:32`). Never `222s`.
- **Cost:** USD with 4 decimal places (`$0.0123`). `null` renders as `—`. Do not parse a decimal into a float and reformat it in a way that changes digits.
- **Counts and tokens:** thousands separators (`1,284`). Units always visible.
- **Timestamps:** show the operator's local time with the UTC offset visible, plus the run date in UTC where relevant. The raw ISO value is copyable. Never convert silently.

---

## 13. States: loading, empty, error

Every data-driven view defines all of these:

- **Loading:** a skeleton that matches the final layout (`loading.tsx`, `SkeletonTable`, `SkeletonDetails`, and so on) with no layout shift. Neutral colors only, subtle animation, respects `prefers-reduced-motion`. Never show "No data" while a request is pending.
- **Empty:** distinguish _no data exists_, _no data matches the filters_, _no access_ and _failed to load_. Each has its own message and next action.
- **Error:** say what failed, give a retry action where useful, and show the request or correlation ID. Use the normalized `ApiError`. Never show stack traces, secrets or raw payloads.

---

## 14. Tables, forms and destructive actions

- Tables: clear column labels, backend sorting/pagination/filtering, hover state, status chips, no decorative row chevrons, no unnecessary columns. Horizontal scroll on narrow screens, with the identifying column kept visible.
- Forms: labels, help text, inline validation from the zod schema, required indicators, disabled and loading states, no secrets in form state longer than needed.
- Confirm high-impact actions with an accessible dialog that states **what will happen, which resource, and whether it is reversible and costs money**. Do not use a bare "Are you sure?". Today that means the `force` re-run.
- Warn before navigating away from a form with unsaved input.

---

## 15. Accessibility, responsiveness and performance

- Everything interactive has an accessible name, keyboard access, a visible focus style, a disabled state and sufficient contrast. Dialogs trap and restore focus. Never rely on color alone.
- Works from 320 px to wide desktop. Check navigation, tables, forms, filters, dialogs and the overview.
- Prefer Server Components, avoid large client bundles and unnecessary rerenders, paginate everything, debounce high-frequency inputs, avoid repeated requests.
- No service worker and no offline caching. Authenticated operational data is never cached by the browser beyond normal HTTP semantics (`no-store`).

---

## 16. Developer experience and code quality

The codebase must be clean, professional and easy to pick up.

- **README** (`dashboard/README.md`): what it is, prerequisites, environment variables (names and meaning, no values), how to install, run, test, build and run in Docker, the folder map, and links to the root docs. Keep it current when behavior changes.
- **Scripts** in `package.json`: `dev`, `build`, `start`, `lint`, `format`, `format:check`, `typecheck`, `test`, and `check` (runs lint, format check, typecheck, tests). One command a new developer can run before pushing.
- **Tooling:** strict TypeScript, ESLint, Prettier, `.editorconfig`. No lint warnings left behind. No `// eslint-disable` without a one-line reason.
- **Code style:** small focused functions, meaningful names, early returns, no dead or commented-out code, no `console.log` (nothing in the browser, structured logs on the server), no magic numbers (name constants), no `TODO` without a clear owner and reason. Comments explain _why_, not _what_.
- **Errors:** handled in one consistent way (normalized `ApiError`), never swallowed, never leaking internals.
- **Types:** derive from the shared contracts; do not redefine API shapes.
- **Tests live under `tests/`**, mirroring `src/`, with readable names that describe behavior.

---

## 17. Testing

Use Vitest and Testing Library. Do not rely on type checking alone.

Test at least: every status chip maps every enum value to a label and tone; formatters (duration, cost with `null`, timestamps); `safeNextPath` (accepts `/executions`, rejects `//x`, `/\x`, `https://x`, `/login`, encoded variants); password and session verification (constant-time path, tampered cookie rejected); the API client (timeout, normalized errors, response validation failure); middleware redirect for unauthenticated requests; the auto-refresh component stops when all executions are terminal; loading, empty, no-match and error states; the submit form validation and the force-confirmation dialog.

Never weaken an assertion to make a test pass.

---

## 18. Validation

After any code change, run inside `dashboard/`:

```
npm run check      # lint + format check + typecheck + tests
npm run build
```

For visible UI changes, also run the app and check the affected route at desktop and mobile widths, including a system dark-mode preference to confirm the interface stays light, in normal, loading, empty, error and disabled states. Report what you actually ran and saw. Do not claim a UI change is complete from compilation alone.

---

## 19. Definition of done

A dashboard change is complete only when:

1. It follows the App Router and feature structure above, and `page.tsx` stays thin.
2. Server and Client boundaries are minimal and correct.
3. All API access goes through the typed server-side client with validated responses.
4. No secret reaches the browser, source, logs, URLs or tests.
5. Auth gates every route except `/login`, and redirects are safe.
6. Integration status, citation absence, unknown values and the provider/extraction split are shown truthfully (section 7).
7. Existing light tokens are reused; the interface stays light under both system color-scheme preferences.
8. Loading, empty, error and disabled states exist and match the layout.
9. Accessibility and responsive behavior are verified.
10. High-impact actions are confirmed with specific wording.
11. Formatters are shared and tested; numerals are tabular; identifiers are mono.
12. `npm run check` and `npm run build` pass, and the running app was verified.
13. The README is accurate.
