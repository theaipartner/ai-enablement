# scripts/archive

These scripts were one-shot tools that have served their purpose. They live here for historical reference — to show what was done, when, and how — not as live tools. Do not run them; the systems they touched have moved on.

- `merge_client_duplicates.py` — Hard-coded merge of 4 auto-created client duplicates (Dhamen, Javi, Nicholas, Musa) into their canonical Active++ rows. Replaced by the Gregory dashboard's "Merge into…" flow on the Clients detail page (migration `0015_merge_clients_function.sql` + Server Action). Archived during M3.2 when the dashboard merge feature shipped.
- `backfill_summary_docs_for_fathom_cron.py` — Repaired the 15 client-category calls from M1.2.5's first cron sweep that landed without `call_summary` documents because the adapter didn't recognize Fathom's `markdown_formatted` key. The adapter is fixed and the gap is closed; this exact failure mode can't recur. Archived during M3.2 cleanup.
- `backfill_team_slack_ids.py` — One-shot resolver of `team_members.email` → `slack_user_id` via `users.lookupByEmail`. Ran once after the team_members table was seeded. New team members added later won't have their Slack IDs auto-resolved — that gap is logged in `docs/archive/historical/known-issues.md` and belongs as a fix to `seed_clients.py` (or a small follow-up tool), not as a reason to keep a one-shot in active scripts/. Archived during M3.2 cleanup.

### Archived 2026-06-22 (repo cleanup)

These were completed backfills/validators still sitting in active `scripts/`. Each ran against a now-shipped feature; none is wired into a cron (`vercel.json`) or any test. Kept for re-run reference if a data class ever needs rebuilding.

- `backfill_call_reviews.py` — Generated `call_review` documents for the May 2026 call backlog (Call Review V1, 31/31, ~$1.53 Sonnet). The Fathom pipeline now auto-generates reviews on ingest, so the backlog can't reopen.
- `backfill_nps_from_airtable.py` — One-shot pull of NPS Survey segments from Airtable into `clients.nps_standing` (Path 1, 2026-05-10). Live webhook + cron keep it current now.
- `backfill_setter_call_reviews.py` — One-shot backfill of `setter_call_reviews` (2026-05-20).
- `backfill_setter_call_transcripts.py` — One-shot backfill of `setter_call_transcripts` (Deepgram transcription, 2026-05-19).
- `backfill_slack_client_channels.py` — Historical Slack message ingest for client channels (Ella V2 Batch 1). Realtime ingestion covers new messages going forward.
- `backfill_closer_new_form_fields.py` — Backfill of the new typed columns on the closer-report mirror after the schema add (2026-05-24).
- `smoke_post_cs_call_review.py` — One-shot validation of the CS call-summary Slack post path.
- `smoke_sales_dashboard_queries.py` — One-shot validation of the sales-dashboard queries against the mirror tables.
