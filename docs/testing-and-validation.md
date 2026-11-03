# Testing and validation

Results at release (3 November 2026): **133 of 133 tests passed** (`npm test`) and **38 of 38 browser checks passed** (`npm run e2e`). No code-coverage percentage is claimed; coverage was not measured.

## How the database is tested

`tests/sql/supabase-stubs.sql` creates stand-ins for the Supabase roles (`anon`, `authenticated`, `service_role`), the `auth` schema and Supabase's default function grants. The test then loads every real migration into **PGlite** (PostgreSQL compiled to WebAssembly) and runs queries as each role with the claims Supabase would send. The rules under test are therefore the same SQL the live project runs.

## Suites

| Suite | Tests | What it checks |
| --- | --- | --- |
| `db.test.ts` | 26 | Only the 15 roll numbers exist; code hashing; throttling per roll and per network; RLS for students, admin and anonymous; two-step rules for the administrator; triggers |
| `submissions.test.ts` | 22 | Draft-free server path: explicit submission, duplicate refusal, distinct-student counts, failed submissions leave data untouched, many interleaved submissions give exact counts, SQL and TypeScript matching agree |
| `security.test.ts` | 37 | Placement-team sign-in steps (PIN, own password, device), session revocation, suspension, company scoping, "All companies", activity-log immutability, alerts, rate limits, the full list of functions callable by anonymous and signed-in users |
| `coordinator-api.test.ts` | 26 | Edge-function handlers (`staff-login`, `admin-team`, `coordinator-api`) run in Node against PGlite with real WebCrypto keys: sign-in throttling and generic errors, provisioning, exports and their contents, refused requests |
| `analytics.test.ts` | 13 | Metrics, distinct counts, pie slices, upcoming assessments, stage distribution, IST dates, company grouping, the three-sheet workbook |
| `names.test.ts` | 8 | Names readable only by the student and the administrator; live updates do not carry student rows |
| `sha256.test.ts` | 1 | The SHA-256 used by the offline version matches Node's |

## Browser end-to-end (`tests/e2e/`)

`mock-supabase.ts` starts a local stand-in for Supabase: the real migrations in PGlite, a PostgREST-style API, sessions and sign-out, and the real shared handlers for `staff-login`, `admin-team` and `coordinator-api`. `run.ts` builds the website against it, serves it with the production security headers, and drives Chromium through Playwright:

- two students sign in, enter names, add companies and submit; the chart groups spellings;
- the administrator signs in (a wrong password gets the generic message), sees names and downloads a three-sheet export;
- a placement-team login is issued and completed (PIN, own password, computer registration); it sees roll numbers only for its company, exports, saves outreach notes and opens a company from the chart;
- a second browser with the right password and PIN is refused, an alert appears, and direct API and database calls from it return nothing;
- the administrator approves a new computer and later suspends the account, and both take effect.

Supabase Auth's real token signing and Supabase's own rate limits are outside this stand-in; sign-in, export and the placement-team PIN flow were also exercised by hand on the live project.

## Other release checks

| Check | Result |
| --- | --- |
| `npm run typecheck` (TypeScript strict) | No errors |
| `npm run build:web`, `npm run build:offline` | Built |
| Deno 2.1 type-check of all six Edge Functions | No errors |
| Database updates applied to a copy of the live schema, twice | No data change, repeatable |
| detect-secrets scan of source and build | Only false positives (labels, test-only values) |
| Manual check on the live site after each deployment | Sign-in, names, export and new screens working |
