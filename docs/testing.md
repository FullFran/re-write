# Testing

| Suite | Command | What it covers |
| --- | --- | --- |
| Unit and server tests | `npm test` | Domain, CLI, HTTP API and the review page's code against a fake DOM. No added dependency. |
| HCS traceability | `npm run hcs:trace:check` | The conformance map is up to date. |
| Agent journeys | `npm run eval` | The MCP harness, no model and no network ([evals](evals.md)). |
| Browser tests | see below | The real `/review` page in headless Chromium. |

CI runs each one as its own job in `.github/workflows/ci.yml`: `test`, `eval`, `browser`, plus `image` for the container.

## Browser tests

`browser-tests/` is a separate package so that Playwright stays out of the product and its unit tests: the root `package.json` and `npm test` do not depend on it. It pins one exact `@playwright/test` version in its own lockfile.

Each test starts `browser-tests/server.ts`, which runs the real server (`src/adapters/http-server.ts`) over a fresh synthetic book made from `fixtures/demo-book/`, then drives `/review` in Chromium and checks both what the page shows and the manuscript bytes on disk. Requests that leave `127.0.0.1` are aborted.

Sign-in does not call Clerk. The page loads Clerk's two scripts from the issuer, so the test issuer serves stand-ins for them next to its JWKS: the stand-in `window.Clerk` has only what the page uses (`load`, `isSignedIn`, `session.getToken`, `mountSignIn`, `mountUserButton`), and `getToken` returns a session token signed by the test issuer's key. The server verifies that token as it verifies a real one, so the page runs its own code against the real server.

| Test | Checklist |
| --- | --- |
| Rejecting a proposal | [§3](review-checklist.md#3-reject-a-proposal) |
| A stale proposal | [§4](review-checklist.md#4-accept-a-proposal), [§6](review-checklist.md#6-verify-stale-proposal-handling), part of [§5](review-checklist.md#5-confirm-history-and-audit-trail) |
| Unreviewed claims and Canon | part of [§5](review-checklist.md#5-confirm-history-and-audit-trail) |
| Phone layout at 390 × 844 | part of [§9](review-checklist.md#9-phone-layout) and [§10](review-checklist.md#10-section-navigation-and-folding) |

Run them locally with Node 24:

```bash
npm ci
cd browser-tests
npm ci
npx playwright install chromium
npx playwright test
```

On a failure, `browser-tests/test-results/` holds a screenshot and a trace for each failed test (`npx playwright show-trace <trace.zip>`); in CI the `browser` job uploads them as the `browser-results` artifact.
