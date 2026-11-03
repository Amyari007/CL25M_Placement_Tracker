# Security implementation

Principle: **every access rule is enforced inside the database or a server function.** Hiding a button is never the control.

## Authentication

| User | Method | Protection |
| --- | --- | --- |
| Student | Roll number + access code via `student-login` | bcrypt hash (pgcrypto, cost 10); 5 failures per roll number or 30 per network in 15 min pause sign-in; same message for unknown roll and wrong code |
| Administrator | Email + password via `staff-login` | 5 failures per account or 30 per network in 15 min; generic errors; optional authenticator two-step (AAL2 then required by `is_admin()`) |
| Placement team | Email + password via `staff-login`, then own 6-digit PIN, then registered browser | Temporary password must be replaced; PIN hashed with bcrypt, 5 wrong PINs lock PIN entry for 15 min; requests signed by a non-extractable WebCrypto key held in the registered browser |

Access codes and PINs are never stored in plain text. Codes reset by the administrator are random 6-digit numbers generated server-side, and the student's sessions are ended.

## Authorisation

- **Row-level security** on `students` and `applications`: a student reads only their own rows; the administrator reads all rows while their sign-in session still exists.
- **Column grants**: the browser role cannot select `students.name`. Students read their own name through `my_profile()`; the administrator through `admin_student_names()`.
- **Write path**: students cannot insert, update or delete applications directly; the only path is `submit_applications()`.
- **Server functions** re-check the caller on every call (`is_admin()` or the placement-team gate).
- **Function grants** are set explicitly for every function, because Supabase grants new functions to API roles by default. Anonymous visitors can call only the four text helpers used for company matching.

## Activity log and alerts

- Events: sign-in success and failure, exports, list views, refused requests, code resets, team and device changes, alert reviews.
- Each event records account, role, time, outcome, company, IP as reported by the hosting gateway, browser user agent and a request id. No passwords, codes or tokens are logged.
- The table rejects UPDATE, DELETE and TRUNCATE through triggers; API roles have no write access. Retention is 180 days.
- Alert rules (repeated exports, many companies in an hour, repeated refusals, failed sign-ins, wrong PINs, unknown browsers) create reviewable alerts for the administrator; none blocks an account by itself.

## Website

`scripts/security-headers.mjs` writes Netlify's `_headers` with:

- `Content-Security-Policy` allowing only the app's own inline script (by SHA-256 hash) and the Supabase project address; `default-src 'none'`, `frame-ancestors 'none'`, `object-src 'none'`.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`.

## Export safety

Spreadsheet cells whose text starts with `=`, `+`, `-`, `@`, tab or carriage return (including full-width variants) are stored with a leading apostrophe, so they display as text and never run as formulas.

## Secrets

- Only the public Supabase URL and publishable key are built into the website.
- The service key lives only in Supabase's Edge Function environment.
- `.env` files are git-ignored; `.env.example` holds placeholders.
- The source and built site were scanned with detect-secrets before release.

## Not covered

- The free plan offers no automatic backups.
- The activity log can still be altered by the database owner through the Supabase dashboard; it is append-only for application roles, not cryptographically tamper-proof.
- No independent security review or penetration test has been carried out.
