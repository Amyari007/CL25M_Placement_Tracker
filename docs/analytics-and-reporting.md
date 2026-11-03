# Analytics and reporting

## Student view

`company_application_stats()` returns, per company group: display name, number of distinct students and percentage of all distinct student–company applications. It is available to a student only after their first submission, and it never returns IDs, names or roll numbers. The student's chart reloads every 30 seconds and when the tab regains focus.

## Administrator view

Computed in the browser from data the administrator may read under row-level security (`supabase/functions/_shared/analytics.ts`):

| View | Content |
| --- | --- |
| Overview | Registered students, completed profiles, students with and without applications, application records, unique companies, upcoming assessments, roster with last activity |
| Pie chart | Distinct students per company (top companies plus "Other") |
| Bar chart | Students per company, highest first |
| Stage distribution | Applications per stage, with stored defaults reported separately |
| Upcoming assessments | Dated applications from today, soonest first, excluding rejected and withdrawn |
| Company drill-down | Applicants for one company |

The dashboard reloads on Supabase Realtime changes to `applications`, on tab focus and every 60 seconds.

## Excel export

`admin-export` re-checks administrator rights, reads with the administrator's token and builds the workbook with ExcelJS (`supabase/functions/_shared/workbook.ts`). Times are shown in IST.

| Sheet | Columns |
| --- | --- |
| Student Roster | Roll number · Student name · Number of applications · Upcoming assessments · Last updated (IST) |
| Company Applications | Roll number · Student name · Company name · Role · Application stage · Test date · Notes · Created (IST) · Last updated (IST) |
| Company Analytics | Normalized company name (match key) · Display company name · Total applications · Distinct students applying · Percentage of total applications · Spellings grouped |

Each sheet has a title, generation time, frozen header and filters. Formula-like text is stored as text. Each export is recorded in the activity log.

## Placement-team report

A placement-team member can export one assigned company at a time: roll number, stage, assessment date and applied-on date, marked confidential. Names and notes are not included.
