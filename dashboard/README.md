# CrowdReply operator dashboard

Next.js App Router, React and strict TypeScript. Tailwind v4 provides theme tokens; feature CSS keeps the operational layout compact. See [root quick start](../README.md), [dashboard rules](AGENTS.md) and [provider research](../tasks/PROVIDER_CAPABILITIES.md).

The dashboard server calls the separate Express API. The browser receives a signed, httpOnly, SameSite=Strict session cookie, never an API key or password. Login is throttled after five failures, with a visible cooldown countdown. Local sign-in help explains where the administrator configured credentials without displaying values. Session lifetime is one hour; production cookies require HTTPS.

## Run

Use Node 24 or newer and npm. Install root dependencies, then run `npm ci` here. Create and populate the root git-ignored `.env` yourself; never expose it on camera. Start the API/worker through the root instructions, then `npm run dev` here. The development dashboard binds to loopback port 3001.

Required server-only variables: `OPERATOR_USERNAME` and `OPERATOR_PASSWORD` (login), `SESSION_SECRET` (cookie HMAC), `OPERATOR_API_KEY` (API authentication), `API_BASE_URL` (API origin; defaults to loopback port 3000). `NODE_ENV` controls secure production cookies. Runtime values must be supplied to the container; builds do not contain credentials. Use an HTTPS reverse proxy for production access.

| Command                                   | Purpose                                                    |
| ----------------------------------------- | ---------------------------------------------------------- |
| `npm run dev`                             | Local Next.js server, reads the root .env if present       |
| `npm run check`                           | ESLint, Prettier, strict typecheck, Vitest/Testing Library |
| `npm run build`                           | Production standalone compilation, telemetry disabled      |
| `npm run start`                           | Local production server on loopback port 3001              |
| `npm run lint`                            | Lint with zero warnings                                    |
| `npm run format` / `npm run format:check` | Apply/check formatting                                     |
| `npm run typecheck` / `npm run test`      | Independent compiler/test checks                           |

## Layout and behavior

`src/app/login` owns login; `src/app/(console)` owns Overview, Executions, Submit, Providers, Visibility and Settings → Provider keys. Shared primitives live in `src/components`; server-only clients in `src/lib/api`; HMAC, credential checks and safe redirects in `src/lib/auth`; shared display formatters in `src/lib/format`. Tests mirror these boundaries under `tests/`. All response bodies are validated; client components import shared contract types only.

The home screen starts with a real buyer-question form. Provider choices and workspace health are expandable; configured Mock/Live counts stay visible before submission. Answers start with question text, provider and a Read answer/View progress action. Model, latency and cost are available under Run details. Answer detail leads with the provider answer, citations and brands; technical facts have their own disclosure. Phone and tablet navigation folds behind Menu, including sign-out. Visibility starts with Live evidence only; exploring Mock evidence requires an explicit action.

Notifications use the user-requested `@cloudlet/toast` **1.2.0**. A browser-owned controller is created and disposed by `NotificationOwner`; the server never shares one across requests. Loading notifications update to success or error without automatic retries or cancellation of paid work. Results and errors also remain inline. Provider-key inputs clear before saving and stay disabled until completion. The package stylesheet is imported once; application button styles exclude its notification controls.

Temporary provider keys are submitted to a Server Action, cleared from the password input immediately, encrypted by the API in Redis and expire within one hour. User key wins over server environment key; absent keys select Mock. Google AI search is always Mock and is not Gemini. Executions display their stored mode, never a current provider setting. Unknown values render as an em dash. Citation absence is separate from failure; extraction is separate from provider status. Mock counts are separate from live counts, and Overview explicitly samples only the latest 100 executions.

The framed-sheet direction uses the supplied blue-grey operational palette and restrained 8px sheet corners required by the project. Its signature is execution provenance beside each answer and a truthful live spend cap. UX refresh direction seed: 452999756; no redraw. The skill's larger corners were overridden by the project rules. System fonts are declared explicitly so the interface does not claim to load unavailable IBM Plex files.

The dashboard is light-only at the Director's latest request (2026-11-03), which supersedes the earlier dark reference. The existing white and blue palette, compact spacing, stronger input outlines and explicit hover/focus/disabled/error states remain. System dark-mode preferences do not change the interface; Cloudlet is explicitly set to light while preserving forced-colors support.

## Docker

The root Compose setup uses `dashboard/Dockerfile` with the **repository root as build context** so server-only contracts are available. It produces a non-root standalone image. The local stack was exercised with Mock providers; this does not prove production deployment or live provider compatibility. Root `.dockerignore` excludes all `.env` files.

## Known limitations

- IBM Plex was requested, but no local font files/OFL licenses were available and external font downloads were prohibited. The UI explicitly uses a system-font fallback; no unlicensed fonts are bundled. Supply approved IBM Plex Sans/Mono OFL files before enforcing font-specific visual acceptance.
- Next.js 16 uses `src/proxy.ts` as the authenticated route gate; its redirect and session behavior are tested.
- The API exposes attempt count, latest error and next retry, rather than detailed attempt history. Brand extraction, provenance and version history are shown separately from provider success; failed extraction does not replay the provider call.
- Paid execution remains blocked pending a proven billing bound. Adding a key does not enable paid calls.
- The overview is a bounded recent sample, not full historical analytics. A verified global force-rerun counter is still needed before running multiple API replicas.
- Unit checks do not replace desktop/mobile browser inspection, including a system dark-mode preference to confirm the interface stays light. Browser verification results are reported separately.
