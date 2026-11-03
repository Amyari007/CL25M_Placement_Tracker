# Company-name normalisation

Students type company names freely, so the same employer arrives in many forms. Matching runs in two stages, implemented identically in SQL (`supabase/migrations/20261026100000_submissions_and_team.sql`) and TypeScript (`supabase/functions/_shared/analytics.ts`).

## Stage 1: comparison key

| Step | Example |
| --- | --- |
| Unicode NFKD, accents removed | "Nestlé" → "nestle" |
| Lower case | "COMMOTION" → "commotion" |
| `&` → `and` | "Johnson & Johnson" → "johnson and johnson" |
| Everything except `a–z`, `0–9` becomes a space | "Commotion Pvt. Ltd." → "commotion pvt ltd" |
| Trailing legal/generic words dropped (while more than one word remains) | "commotion pvt ltd" → "commotion" |
| Words joined | "johnson and johnson" → "johnsonandjohnson" |

Words dropped from the end: pvt, private, ltd, limited, llp, llc, inc, incorporated, corp, corporation, co, company, plc, gmbh, ag, sa, bv, india, technologies, technology, tech.

## Stage 2: typo tolerance

Two keys are the same company if they are equal, or if all of these hold:

1. Both keys are non-empty and start with the same letter.
2. Their digits are identical ("Company 1" ≠ "Company 2").
3. Their optimal string alignment (Damerau–Levenshtein) distance is within the budget for the shorter key:

| Shorter key length | Allowed edits |
| --- | --- |
| up to 4 | 0 |
| 5 to 8 | 1 |
| 9 or more | 2 |

An adjacent swap ("Siemsn" ↔ "Siemns") counts as one edit.

## Grouping

Keys are processed from most used to least used. Each key joins the first existing group it matches, otherwise it starts a new group. A rare typo therefore joins the common spelling, never the reverse. The display name of a group is its most-used spelling, preferring one with capital letters.

## Where it is used

- Student draft list: near-duplicates are flagged before submission.
- `submit_applications()`: near-duplicates in one list are refused.
- Statistics, administrator analytics, Excel export (the "Spellings grouped" column) and placement-team company assignments.

## Verification

`tests/analytics.test.ts` covers case, spacing, punctuation, suffixes, typos and genuinely different companies; `tests/submissions.test.ts` checks that the SQL and TypeScript implementations give the same groups.
