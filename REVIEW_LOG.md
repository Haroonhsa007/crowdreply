
## Dashboard usability refresh — 2026-11-03

- Read-only Luna/high audit; Sol/high auth/shell implementation; Astra/high
  workspace implementation. Framed-sheet direction seed 452999756 keeps project
  palette/corners. No new packages, fonts, provider calls or git commands.
- Navigation folds at tablet/phone widths with reachable sign-out, Escape and
  current-route focus restoration. Execution rows preserve all fields on phones.
  Provider selection uses actual configured modes; example-fill focuses input.
  Empty states offer a real next action and Mock visibility is explicit opt-in.
- Sign-in now explains local operator access, supports password visibility and
  shows the server-enforced cooldown. Password state/DOM clear on submission.
- Fresh read-only gpt-6-astra/high CLI review found two MEDIUM issues: failed
  question submissions lost input; mobile current-route selection lost focus.
  Both fixed with regressions. Follow-up found no correctness regressions and
  one LOW test gap; strengthened pre-submission confirmation invalidation test.
- Final dashboard check: lint/format/typecheck pass, 51 tests across 9 files.
  Production host build and Docker image build pass; all five services healthy.
- Production Chrome screen matrix: six routes x three widths x two themes = 36
  checks; no page overflow and no runtime page errors. Targeted final production
  checks pass: failed login/password clearing/reentry Show-Hide/correct retry,
  Secure HttpOnly cookie, mobile Menu/Escape/current-route focus/sign-out,
  example fill/focus/full-width textarea, explicit Mock evidence and logout.
- Browser harness corrections: wait for the login form's error, not Next's route
  announcement; scope duplicate Submit links to main navigation. An earlier
  premature assertion incorrectly suggested Show/Hide was erasing reentered
  input. Final checks wait for the actual form response and pass.
- Skill lint: zero FAIL, six explained warnings (existing palette, ID mono,
  dialog-only shadow, clock zero padding, honest unknown dashes). Login inspector:
  zero FAIL, one accepted warning for intentional whitespace around a focused
  authentication form. Inspected desktop/tablet/phone screenshots.
- Secret scan: 2,384 source/build files; six configured credential values checked;
  no leaks, logs clean, private .env mode 600, provider keys absent.
- IBM Plex files remain unavailable under the existing no-download constraint;
  declared system fonts are intentional. Remote/live/scale claims unchanged.

## Product-first forms and Cloudlet — 2026-11-03

- Director rejected the operations-first UX and explicitly requested Cloudlet
  notifications, proper forms, responsiveness, Astra review, ECC and taste.
- Home now begins with the actual question composer. Answers lead with provider,
  question, evidence and a real Read answer/View progress action. Operational
  metrics, model/IDs/usage and extractor provenance remain in native disclosures.
- Pinned user-requested @cloudlet/toast 1.2.0; official docs read for App Router,
  controller, accessibility and styling. Browser-owned controller, scoped CSS,
  loading -> success/error updates, persistent inline feedback; no paid retries.
- Sol/high implemented detail and key protection; Astra/high implemented composer,
  validation and accepted-result revalidation; Luna/high audited user tasks.
- Fresh independent gpt-6-astra/high CLI review using ECC make-interfaces-feel-better
  and taste app-screen guidance found 3 MEDIUM/1 LOW: Cloudlet hover overlay,
  stale post-submit history, editable pending key input, small disclosure targets.
  All fixed. Follow-up: no remaining findings in scope. CLI headers confirm the
  requested model/effort; reviewer did not execute tests or browser checks.
- Delayed key tests exposed transition-delayed clearing and old key resurfacing.
  Controlled input + synchronous clearing + disabled pending state fix both;
  success/error/rejection coverage preserves every assertion.
- Final dashboard check: lint/format/typecheck pass, 76 tests/12 files pass.
  Production host and Docker builds pass; all five services healthy.
- Real production Chrome: required validation/focus, five Mock results, Cloudlet
  success/error, transparent pill hover/open/close, saved answer/technical
  disclosure, retained failed input, no automatic retry, mobile Menu/focus pass.
  Seven routes x four widths (1440/768/390/320) x two themes = 56 screen checks;
  zero overflow and zero runtime page errors. Native date overflow found at 320px
  was fixed by stacking date/checkbox filters, then full matrix passed.
- Browser harness adjusted to use Cloudlet's accessible pill name (the overlay is
  intentionally textless) and visible committed streaming content, not duplicate
  hidden Next streaming nodes. These locator errors were not product failures.
- Actual authenticated spend response: totalUsd 0, capUsd 2, remainingUsd 2.
  All five selected modes verified Mock before browser submission. No paid call,
  git command, merge, remote deployment or DNS action. Only requested dependency
  added; existing lint deprecation was not expanded into an unrelated upgrade.
- Secret scan: 2,433 source/build files; six configured credential values checked;
  no leaks, container logs clean, .env private/ignored, provider keys absent.

## Reference-palette professional dark theme — 2026-11-03

- User supplied authoritative dark palette and requested professional UI/UX.
  Replaced navy surfaces with #121212/neutral elevation, lavender #BB86FC primary,
  teal #03DAC6 secondary, rose #CF6679 error and explicit black on-fill roles.
  Tightened heading/control/chip sizing, composer spacing, line measure and states.
- Sol/high implemented CSS; fresh gpt-6-astra/high CLI reviewed against ECC/taste.
  Two MEDIUM findings fixed: invalid field border cascade and pending Cloudlet
  submit contrast/hover. Follow-up reported no findings in those fixes. CLI
  headers confirm requested Astra/high configuration; reviewer did not run checks.
- Final dashboard lint/format/typecheck, 76 tests/12 files and host build pass.
  Docker dashboard rebuilt and healthy; existing Mongo/API/worker/Redis preserved.
- Production browser verified all nine exact reference roles and black primary
  button text. Contrast: primary7.93, body18.73, muted7.49, tertiary5.12,
  success8.33, error4.54, info5.94, warning9.74; control boundary3.27.
- Actual invalid question retains rose border on hover/focus after transition.
  Isolated browser CSS fixture verifies pending Cloudlet submit remains readable
  and unchanged on hover; actual app success/error notifications also pass.
- Full production workflow and 56 screens (7 routes x4 widths x2 themes) pass,
  no overflow/runtime errors. Mock-only submission/dedup, failed-input retention,
  no automatic retries, mobile navigation and evidence views remain correct.
- Browser harness normalized minified #000/#fff color notation and waited for
  border-color transitions before exact color assertions. These harness failures
  required no application workaround. No new dependency/git/provider/remote action.
- Updated scoped design rules to preserve the user reference over the earlier
  navy/blue specification and generic violet restrictions. Light palette remains
  compatible; its control boundary was strengthened above3:1.

## Light-only theme — 2026-11-03

- Latest Director request supersedes the dark reference: removed both dark CSS
  media overrides and set Cloudlet theme explicitly to light. Retained current
  light colors, spacing, control states and forced-colors behavior.
- Sol/high implemented the minimal change; rules, README and decisions now say
  light-only. No dependency or backend changes.
- Dashboard check passes lint/format/typecheck and all 76 tests; host and Docker
  builds pass. Production browser verifies login plus eight views under both
  dark/light OS preferences stay white with native color-scheme light, no mobile
  overflow, and actual Cloudlet notification theme/scheme light. Mock-only
  idempotent submission used for the notification check; no paid call.
