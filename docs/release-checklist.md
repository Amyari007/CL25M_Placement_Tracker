# Repository release checklist

## Content

- [x] README with problem, features, architecture, testing and authorship
- [x] Topic documents in `docs/`
- [x] Screenshots in `screenshots/`, checked for private data
- [x] MIT licence
- [x] `.env.example` with placeholders only
- [x] `.gitignore` covering `.env*`, builds, `deploy/`, archives

## Data and secrets

- [x] Real student access codes removed; demo codes are made up and labelled
- [x] No real student names, emails or application records in code or tests
- [x] No live site address, Supabase project ID or keys
- [x] No service-role key anywhere
- [x] detect-secrets scan reviewed
- [x] Image metadata stripped
- [ ] Fresh repository (no earlier history to review)
- [ ] Before making the repository public: reset live student codes, review the analytics screenshot (it shows real company names and counts)

## Verification

- [x] `npm test`: 133/133
- [x] `npm run e2e`: 38/38
- [x] `npm run typecheck`, `npm run build:web`, `npm run build:offline`

## GitHub settings

- Name: `CL25M-Placement-Tracker`
- Description: *Real-time placement application tracking and coordination platform with privacy-preserving analytics, assessment monitoring and secure role-based access.*
- Topics: `react` `typescript` `postgresql` `supabase` `placement-tracker` `analytics-dashboard` `realtime` `row-level-security` `full-stack-development` `netlify`
- Visibility: Private first

## First commit message

```
Initial release: CL25M Placement Tracker

Placement application tracker for the 2026-27 M.Tech Clinical
Engineering batch at IIT Madras: student submissions with
spelling-tolerant company matching, privacy-preserving batch
statistics, administrator analytics and Excel export, placement-team
access, on Supabase (PostgreSQL RLS, Auth, Edge Functions, Realtime)
and Netlify. Includes 133 tests and a browser end-to-end suite.

Demo access codes only; no student data.
```
