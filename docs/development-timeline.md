# Development timeline

Seven days, from specification to a secured live system, during the 2026–27 placement drive.

| Date (2026) | Release | What changed | Trigger |
| --- | --- | --- | --- |
| 26 Oct | v1 first build | React + Supabase app from a written specification: 15 roll numbers, student and administrator workspaces, analytics, Excel export, database tests | Need for a shared record |
| 26 Oct | v1.1 single file | One HTML file that opens without installation; company names made case-insensitive and spelling-tolerant | Classmates could not open a multi-file build |
| 26 Oct | v2 submission workflow | Draft list + Submit Applications; student pie chart of distinct students; live refresh; placement-team approval | Second specification |
| 26 Oct | Preview fixes | In-memory routing, custom form and link components for preview panels | "Invalid URL", frozen sign-in, admin 404 |
| 26 Oct | v3 online launch | Supabase project (Mumbai region), Edge Functions, Netlify site; one shared database | Each device had its own data |
| 27 Oct | Recovery safeguard | Setup script refuses to run when data exists | Accidental database reset |
| 27 Oct | v4 names hidden | Names readable only by the student and the administrator (column grants) | Privacy for the placement team |
| 29 Oct | v5 security hardening | Staff sign-in function, activity log, alerts, rate limits, CSP, function-permission review, export formula safety | Need for individual, accountable logins for the placement team |
| 29 Oct | PIN second step | 6-digit PIN replaced the authenticator app for the placement team | Authenticator codes rejected in practice |
| 29 Oct | v6 company drill-down | Click a company to list roll numbers; "All companies" option; per-application upcoming list | Coordinator request |
| 1 Nov | Technical report | Written record of the work | |
| 3 Nov | Public repository | Sanitised copy: demo codes, no personal data, documentation | Portfolio |
