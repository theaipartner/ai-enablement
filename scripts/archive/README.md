# scripts/archive

These scripts were one-shot tools that have served their purpose. They live here for historical reference — to show what was done, when, and how — not as live tools. Do not run them; the systems they touched have moved on.

- `merge_client_duplicates.py` — Hard-coded merge of 4 auto-created client duplicates (Dhamen, Javi, Nicholas, Musa) into their canonical Active++ rows. Replaced by the Gregory dashboard's "Merge into…" flow on the Clients detail page (migration `0015_merge_clients_function.sql` + Server Action). Archived during M3.2 when the dashboard merge feature shipped.
- `backfill_summary_docs_for_fathom_cron.py` — Repaired the 15 client-category calls from M1.2.5's first cron sweep that landed without `call_summary` documents because the adapter didn't recognize Fathom's `markdown_formatted` key. The adapter is fixed and the gap is closed; this exact failure mode can't recur. Archived during M3.2 cleanup.
- `backfill_team_slack_ids.py` — One-shot resolver of `team_members.email` → `slack_user_id` via `users.lookupByEmail`. Ran once after the team_members table was seeded. New team members added later won't have their Slack IDs auto-resolved — that gap is logged in `docs/known-issues.md` and belongs as a fix to `seed_clients.py` (or a small follow-up tool), not as a reason to keep a one-shot in active scripts/. Archived during M3.2 cleanup.
