# Docs Reorganization — Move Manifest

**Created:** 2026-06-22 · **Status:** DRAFT — awaiting Drake approval before execution.

Nothing is deleted. Every file **stays**, **moves**, or goes to **archive/** (recoverable, labeled).
Dates are last-commit dates from git. Status calls: **Current** (recent + likely accurate),
**⚠️ Review** (old or possibly stale — verify against code), **Archive** (dead/historical).

## Target structure

```
docs/
  README.md                ← NEW: index / map (the single entry point)
  onboarding/              ← NEW: first-day + architecture-101 (Phase 5)
  sales/                   ← domain: sales (existing clean set + 2 pulled in)
  fulfillment/             ← NEW domain: everything-else narrative/architecture docs
  schema/  runbooks/  decisions/  agents/   ← shared reference, organized by type (keep)
  archive/
    legacy-workflow/       ← specs/ + reports/ + collaboration.md (retired Director/Builder workflow)
    historical/            ← point-in-time work notes + full pre-slim CLAUDE.md snapshot
```

Pattern: **narrative/architecture docs grouped by domain (sales / fulfillment); reference material
kept by type (schema / runbooks / decisions / agents); dead and point-in-time material archived.**

---

## 1. → `archive/legacy-workflow/` (the big noise reduction)

| Source | Count | Date | Why |
|---|---|---|---|
| `docs/specs/*.md` | 49 | 05-15→06-05 | Artifacts of the retired Director/Builder workflow. |
| `docs/reports/*.md` | 57 | 05-10→05-25 | Same — execution reports for that workflow. |
| `docs/collaboration.md` | 1 | 04-20 | Drake/Zain work-division process doc, tied to the old workflow. |

A `README.md` in that folder will explain: *"Artifacts of a retired AI-assisted workflow (chat-Claude
wrote specs → Claude Code executed → wrote reports). Kept for history; not maintained, not a guide to
current process."* Keep `docs/reports/.gitkeep` semantics if any tooling expects the folder.

## 2. → `archive/historical/`

| Source | Count | Date | Why |
|---|---|---|---|
| `docs/data/*.md` | 4 | 05-04→05-08 | M5 cleanup diffs / backfill notes — point-in-time, done. |
| `docs/working/gregory-redesign-compiled.md` | 1 | 05-12 | Compiled redesign work artifact. |
| `CLAUDE.md` (full, pre-slim snapshot) | 1 | — | Preserved as `CLAUDE-full-2026-06-22.md` when CLAUDE.md is slimmed (Phase 4). |

## 3. → `docs/sales/` (pull the 2 loose sales docs into the clean set)

| Source → dest | Date | Status |
|---|---|---|
| `sales-dashboard-architecture.md` → `sales/` | 06-11 | Current |
| `sales-sql-aggregation-plan.md` → `sales/` | 06-19 | Current |

Existing `sales/` (8 files, all touched 06-12→06-22) stay put — this is the healthy model.

## 4. → `docs/fulfillment/` (NEW — the loose fulfillment narrative docs)

| Source → `fulfillment/` | Date | Status |
|---|---|---|
| `architecture.md` | 04-29 | ⚠️ Review — core doc but ~2mo old; likely partially stale. |
| `gregory-conventions.md` | 05-23 | Current |
| `high-ticket-funnel-explained.md` | 06-05 | Current |
| `data-hygiene.md` | 05-08 | ⚠️ Review |
| `client-page-schema-spec.md` | 05-08 | ⚠️ Review — may be superseded by `schema/` per-table docs. |
| `known-issues.md` | 05-23 | ⚠️ Review — Drake reports it's effectively unused; gets a staleness banner. |
| `future-ideas.md` | 05-15 | Current (backlog/roadmap) |
| `state.md` | 05-28 | Historical-reference — label "search, don't read top-to-bottom"; candidate to distill later. |
| `PERFORMANCE-SCALING-DEBT.md` (from repo root) | — | ⚠️ Review |
| `architecture/ella_user_token.md` | 05-08 | Current — subsystem deep-dive. |
| `architecture/fathom_webhook.md` | 05-08 | Current — subsystem deep-dive. |
| `conventions/call_titling.md` | 05-03 | ⚠️ Review — relates to ADR 0002. |
| `ingestion/metadata-conventions.md` | 05-07 | Current — KB validator contract, still enforced. |

(Empties `docs/architecture/`, `docs/conventions/`, `docs/ingestion/` — those single-file dirs fold in.)

## 5. Stay as-is — shared reference (by type)

| Dir | Count | Notes |
|---|---|---|
| `docs/schema/` | 54 | Per-table reference. 9 date to 04-xx (`agent_runs`, `escalations`, `call_participants`, etc.) — flag "verify against live schema." Stamp last-updated dates; don't reshuffle. |
| `docs/runbooks/` | 40 | Operational. **Closest staleness scrutiny** — a followed-but-stale runbook causes real damage. ⚠️ Review the 04-xx set: `setup_wsl`, `seed_clients`, `inspect_ingestion`, `adding_new_ingestion_source`, `fathom_sanity_checks`. `backfill_nps_from_airtable.md` pairs with a now-archived script → consider archiving. |
| `docs/decisions/` | 5 | ADRs 0001–0005. Immutable historical record by design — keep, no staleness concept. |
| `docs/agents/` (+ `ella/`) | 6 | Agent specs (gregory, call_reviewer, ella×4). Current except `ella/ella-v1-scope.md` (05-05) ⚠️ — possibly superseded by `ella.md`. Kept as a by-type reference category. |

## 6. Repo root after reorg

| File | Action |
|---|---|
| `README.md` | Stays at root (GitHub front door); slimmed to a lean pointer into `docs/`. |
| `CLAUDE.md` | Stays at root (Claude Code auto-loads it); slimmed to current truth (Phase 4); full version → `archive/historical/`. |
| `PERFORMANCE-SCALING-DEBT.md` | **Moves** into `docs/fulfillment/`. |

Result: no content docs floating at root — only the two front-door files that are *supposed* to be there.

---

## Execution phases (after approval)

1. Create `archive/legacy-workflow/` + `archive/historical/` + `fulfillment/`; `git mv` per §1–§4. Write the two archive READMEs.
2. Fix internal links broken by the moves (grep for moved filenames across `docs/`, `*.py`, `*.ts`).
3. Freshness pass: stamp the standard header on every live doc; banner the ⚠️ ones. Build `docs/README.md` index manifest.
4. Slim CLAUDE.md + README.md (Phase 4).
5. Onboarding entry point (Phase 5).

## Header stamp formats

```
> **Status:** Current · **Last updated:** YYYY-MM-DD · **Owner:** TBD
> **Status:** ⚠️ Stale — last verified YYYY-MM-DD, may not match current code. Flagged for review.
```

## Open calls for Drake

- `state.md`: keep in `fulfillment/` labeled historical, or archive it? (Lean: keep + label; distill later.)
- `known-issues.md`: keep + banner, or archive? (Lean: keep + banner — it has real content even if unused.)
- `docs/agents/`: keep as a by-type category (current plan), or fold under `fulfillment/agents/`? (Lean: keep — agent specs are a recognizable category.)
