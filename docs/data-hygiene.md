# Data Hygiene

Short, durable rules for what we let into Supabase from any source system.

## Verify field ownership before ingesting

Before a pipeline writes a column or metadata key from an external source, confirm the source is authoritative for that field. If the "real" value lives somewhere else — a person's head, a different tool, a derived calculation — don't import the stale copy. A missing field is a known gap; a stale one is a confident lie, and every downstream consumer (agents, dashboards, reports) treats it as truth.

**Worked example — revenue fields in the Financial Master Sheet.** The sheet has `Contracted Rev`, `Contracted Rev AUD`, and monthly `PP` columns. On review, Scott confirmed the real state of revenue lives in his head; the sheet values drift from reality. So `scripts/seed_clients.py` drops every revenue column at ingestion — no `contracted_revenue_usd`, no `contracted_revenue_currency`, no monthly totals. The importer's metadata shape is five keys (`seed_source`, `seeded_at`, `country`, `nps_standing`, `owner_raw`), and that's final.

The same reasoning later removed the `Standing` column and its derived tags (`owing_money`, the Standing-half of `at_risk`). Standing reliability is unclear; the tags carried that uncertainty into agent behavior.

## Spreadsheet imports — trust the source's working view

When ingesting from a spreadsheet, let the source system's saved views define "what counts." Do not re-derive the business logic of "who is a client, who is active, who matters this quarter" inside the importer. That logic already exists — somebody is maintaining it every day inside the sheet.

The rule, in order:

1. **Ask the owner which view they use day-to-day.** Saved filters like `Active++`, `Aus Active++`, or whatever tab they actually open when they start work encode the real answer. That's the filter.
2. **Ingest from that view, not the raw sheet.** Have the owner pre-filter (via a saved view in Google Sheets) and export only the rows that view shows. Drop that file into your ingestion directory.
3. **Don't try to replicate the view in code.** The moment you start translating "include rows where status is in {active, ghost, paused} except if the note column says X" into Python, you've just built a second source of truth that will drift from the first.
4. **Ask which columns are stale.** The owner knows which columns they update and which they stopped caring about. Skip the stale ones.

**Worked example — the Active++ journey.** The first version of `scripts/seed_clients.py` imported every row with a non-blank Customer Name, status-mapped `Churn` to `status='churned'`, and pulled 168 rows into the DB. A chunk of those were historical churns nobody on the current team owned. Second revision tried to encode the Active++ rule as a Python filter inside the importer (`USA: active/ghost/paused; AUS: active/paused`). That also worked, but it duplicated logic the owner already maintained in the sheet. Third revision — the current one — dropped the Python filter entirely and expects the owner to export their Active++ view directly. The importer is 50 lines simpler, and when the owner decides to widen or narrow the view, the only place that has to change is the sheet.

The same approach applies to any future spreadsheet source: sales pipeline exports, NPS surveys, anything. Don't rebuild the filter in code.

## Canonical source for clients

**Active++ is the canonical definition of "who is a client at this agency."** The sheet owner's saved view encodes that answer; everything downstream derives from it.

The `clients` table holds Active++ plus two other categories that are still clients by other definitions:

1. **Auto-created clients awaiting human review** — tagged `needs_review`, with `metadata.auto_created_from_call_ingestion = true` and a breadcrumb back to the triggering call (`metadata.auto_created_from_call_external_id` and `..._title`). The Fathom ingest pipeline creates these when it sees a 30mins-with-Scott call whose non-team participant isn't yet in `clients`. They're provisional: a reviewer either confirms (clearing the `needs_review` tag) or merges (finds the duplicate, archives the auto-created row). See the "Auto-created client review workflow" entry in `docs/known-issues.md`.
2. **Soft-archived clients** — `archived_at is not null`. Churned clients removed from Active++, or manually archived for any reason. History preserved, not visible to agents.

Any discrepancy between Active++ and "non-archived, non-needs_review rows in `clients`" is a bug. Either the sheet has drifted from reality (fix the sheet, re-run `seed_clients.py`) or something outside the sheet inserted a row (track it down, either merge or promote via the review workflow). The two sources must agree.

## Historical data without ownership is noise, not history

If nobody on the team can vouch for a batch of historical data — its source, its accuracy at ingest time, or the judgment calls that shaped it — don't import it. Soft-archive it, drop it, or leave it out. Real history accumulates forward, under current ownership, with context. Pretending to preserve a pre-ownership batch leaves agents and dashboards reading confidently-wrong context. The cheap fix is starting fresh and writing the playbook for how future events get captured properly.

## The rule, compressed

1. For each field a pipeline is about to ingest, answer: *who owns this, and is this system the one they update?*
2. If the answer is "nobody reliably" or "a different tool" — skip the field.
3. For spreadsheets, import the owner's working view, not the whole file.
4. Note every exclusion in the pipeline's runbook or module docstring so the next person knows why it's missing, not forgotten.
