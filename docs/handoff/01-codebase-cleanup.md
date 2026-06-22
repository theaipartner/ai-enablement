# Session 1 — Codebase Cleanup

**Goal:** Get the repo to a state where a new engineer opening it isn't confronted with ~95 scratch
files, dead specs, and stray artifacts. Pure hygiene — low risk, all reversible. Do this BEFORE the
ownership transfer so there's less to hand over and everything is findable.

**Risk level:** Low. Nothing here touches live code paths, migrations, or production config.

> Read [`00-overview.md`](00-overview.md) first for context. Check items off in this file as you go.

---

## A. Delete untracked scratch (~95 files) — zero impact

These are git-untracked diagnostics/one-shots in `scripts/`. They served their purpose and were never
meant to be committed.

- [ ] Inspect the list first: `git status --porcelain scripts/ | grep '^??'`
- [ ] Confirm none are works-in-progress you want to keep (skim filenames; they're `_diag_*`, `_apply_*`, `_dedup_*`, `_audit_*`, `_fix_*`, `_sweep_*`, plus a few analyst one-shots like `march_*`, `export_cold_leads.py`).
- [ ] Delete: `_diag_*` (61), `_apply_*`, `_dedup_*`, `_audit_*`, `_fix_*`, `_sweep_*`, `_shot_*`, `scripts/.preview/funnel.png`.
- [ ] Delete untracked dirs: `screenshots/`, and confirm `scripts/preview-screenshots/` intent before removing (it's gitignored snapshot output — safe to delete, regenerable).
- [ ] `.claude/scheduled_tasks.lock` — transient lock; delete + ensure gitignored.

**Safe bulk approach:** `git clean -n -d scripts/ screenshots/` to preview, then `git clean -fd` once
the preview looks right. (Preview first — `git clean` is one of the few destructive git ops.)

> NOTE: some untracked one-shots contain real lead PII (e.g. `export_cold_leads.py`, the `_dedup_*`
> scripts reference internal emails). They're already gitignored from committing, but delete rather
> than archive — don't carry PII into the handoff.

---

## B. Archive tracked one-shot scripts (~8) — keep for archaeology, move out of the way

These are **tracked** completed backfills/validators sitting next to live tooling. Move to
`scripts/archive/` with a README rather than delete (useful if a backfill ever needs re-running).

- [ ] Create `scripts/archive/` + `scripts/archive/README.md` (one line each: what it backfilled, when).
- [ ] Move (verify each is truly done — not referenced by any cron in `vercel.json` or any test):
  - `backfill_call_reviews.py`
  - `backfill_nps_from_airtable.py`
  - `backfill_setter_call_reviews.py`
  - `backfill_setter_call_transcripts.py`
  - `backfill_slack_client_channels.py`
  - `backfill_closer_new_form_fields.py`
  - `smoke_post_cs_call_review.py`
  - `smoke_sales_dashboard_queries.py`
- [ ] **Keep in place** (living tooling): `register_*.py` (4 webhook helpers — needed for the URL transfer in Session 3), `run_gregory_brain.py`, `seed_clients.py`, `invite_ella_and_bot_to_client_channels.py`, the `test_*_locally.py` harnesses, `sync_clarity.py`.

> Judgment call: if a "backfill" script is the only way to recover a data class after an outage, it's
> living tooling, not a one-shot. Check each script's docstring before moving.

---

## C. Stray tracked artifacts — fix tracking

- [ ] `tsconfig.tsbuildinfo` — build artifact. Add to `.gitignore`, `git rm --cached`.
- [ ] `.preview-cookie` — transient auth artifact. Add to `.gitignore`, `git rm --cached`.
- [ ] `Data Sheet - Overall Engine.csv` (repo root) — confirm superseded by the dashboard, then `git rm` or move to `docs/`. (It's the local Engine-sheet reference from Close-ingestion planning.)
- [ ] Confirm `scripts/.preview/*.png` (7 sales-v2 preview PNGs, tracked) are still referenced; if not, remove.

---

## D. Sweep shipped specs/reports — the biggest newcomer-confusion source

`docs/specs/` (~48) and `docs/reports/` (~56) are full of **shipped** pairs that the project's own
cleanup cadence (CLAUDE.md § Cleanup cadence) says get deleted at EOD. They never got swept. A newcomer
can't tell live work from finished work.

- [ ] For each file in `docs/specs/`, check its `**Status:**` header. Anything `shipped` or `superseded` with a matching report → both are deletion candidates.
- [ ] **Before deleting:** confirm any architectural rationale was captured in `docs/decisions/` (ADRs). The cadence says decisions must be ADR'd before the spec is deleted. If a shipped spec embodies a decision with no ADR, write the ADR first (or flag it for Drake).
- [ ] Delete the swept shipped spec/report pairs in one hygiene commit.
- [ ] Leave `docs/reports/.gitkeep`.

> Hard rule from CLAUDE.md: never delete a spec/report without Drake's explicit "delete" / "EOD cleanup"
> cue. Get that cue before executing D.

---

## E. `.gitignore` additions (consolidate)

- [ ] Add: `tsconfig.tsbuildinfo`, `.preview-cookie`, `.claude/scheduled_tasks.lock`.
- [ ] Confirm `screenshots/` and `scripts/preview-screenshots/` are covered.

---

## What success looks like

- `git status` is clean (no untracked scratch).
- `scripts/` shows only living tooling + an `archive/` folder with a README.
- `docs/specs/` and `docs/reports/` contain only in-flight work.
- A new engineer running `ls scripts/` and `ls docs/specs/` sees an obvious, small, current set.

## Things NOT to touch in this session

- `supabase/migrations/` — never delete migrations (incl. the inert OnceHub `0092`; that's a Drake decision, tracked in `00-overview.md`).
- `vercel.json`, `api/`, `agents/`, `lib/db/` — live code; no refactors here.
- Anything requiring a credential or env change — that's Sessions 2–3.

## Hand-off note for the next session

When done, update the status line in `00-overview.md` and note here anything you deferred or that
needs Drake's decision (e.g. the OnceHub table, files you weren't sure were dead).
