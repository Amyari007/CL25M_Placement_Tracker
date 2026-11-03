# Limitations

| Limitation | Effect | Mitigation or next step |
| --- | --- | --- |
| Self-reported data | Totals are only as complete as students' submissions | Overview counts students with no applications and shows each student's last activity |
| Free Supabase plan: no automatic backups | Data loss would need manual recovery | Regular Excel export; paid plan or scheduled dump |
| Free plan pauses after about 7 days without activity | Site stops until restored from the dashboard | Regular use during the season |
| Typo grouping can join two genuinely similar names | Rare wrong count | Export lists every spelling grouped under each company |
| Student charts refresh on a 30-second timer | Slight delay compared with the admin dashboard's Realtime updates | Acceptable for this use |
| Registered-browser check identifies a browser profile, not a person or physical device | Someone using the registered computer can use the account | Personal computers only; administrator can suspend at once |
| Activity log is append-only for app roles, not cryptographically sealed | Database owner could alter it | Restrict dashboard access |
| No independent security review | Tests were written by the same process that built the system | Peer or institutional review |
| Built for one batch | Roll numbers are fixed in a check constraint | Change the constraint and seed for another batch |

Not implemented: offer tracking, reminders, location tracking, examination-hall allocation, invigilation or proctoring.
