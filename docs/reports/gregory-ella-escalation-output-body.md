# Report: Gregory — Ella escalation DM body in Output column
**Slug:** gregory-ella-escalation-output-body
**Spec:** docs/specs/gregory-ella-escalation-output-body.md

## Files touched

**Modified:**

- `agents/ella/passive_dispatch.py` — moved the DM body construction up (it only depends on `payload.slack_channel_id`, `payload.triggering_message_ts`, `decision.reasoning` — all available at function entry; spec § A assumed it was in scope at the audit_payload site but it wasn't). Added `"body": body` to the `audit_payload` dict. Inline comment links the write site to the dashboard read path.
- `lib/db/ella-runs.ts`:
  - New `ESCALATION_PLACEHOLDER_PATTERN` constant.
  - New `fetchEscalationBodies` helper: batched fetch from `webhook_deliveries` filtered to `source='ella_passive_escalation_dm'` + `received_at` window around the runs' `started_at`, indexed by `(slack_channel_id, triggering_message_ts)` → body. Forward-only (rows without the `body` key get skipped).
  - New `escalation_body` field on `EllaRunsListRow` (inherited by `EllaRunDetail`).
  - Projection in `getEllaRunsList` and `getEllaRunDetail` populates `escalation_body` from the helper.
  - Placeholder suppression in `output_text`: when `output_summary` matches the escalation pattern, drop it from the `output_text` fallback so the cell renders `—` muted rather than the status string.
  - New `stripSlackLinkSyntax` inside `renderSlackText` so `<https://...|label>` and `<https://...>` render as readable plain text in the list cells.
- `app/(authenticated)/ella/runs/runs-table.tsx` — cell prefers `r.escalation_body ?? r.output_text`. When both are null (suppression hit + no body in audit), renders `—` muted.

**Created:**

- `scripts/verify-ella-escalation-output.ts` — Playwright harness. Captures the full `/ella/runs` list and asserts two text-presence states: (1) the placeholder string `escalated via DM` must NOT appear anywhere on the page (post-fix it's suppressed at the data layer); (2) the body marker `Worth a look` may or may not be present depending on whether a post-deploy escalation has fired.

## What I did, in plain English

Implemented Drake's chosen option (b) from the prior spec's hard-stop surface — persist the DM body to `webhook_deliveries.payload.body` so the dashboard can read it back.

**Python side.** The body local in `_fire_escalation_dm` was constructed after the audit-row insert, so the existing audit payload couldn't include it. Moved body construction up (no behavior change — `body` doesn't depend on the primary_csm check that sits between the original two sites). Added `"body": body` to `audit_payload`. The no-primary-csm early-return path still leaves an audit row with a body (reflects what *would* have been sent), which is fine — the `dm_ok` flag already lives in the run's `output_summary` and signals delivery state independently.

**TypeScript data layer.** Added `fetchEscalationBodies`: a batched fetch from `webhook_deliveries` that loads audit rows in the time window around the runs we're projecting, then JS-hashjoins by `(slack_channel_id, triggering_message_ts)` → body. Avoids the unknowns of Supabase `payload->>'key'` filter performance — overfetches in a narrow time window and indexes in memory. Forward-only by virtue of how the body key works: pre-deploy audit rows don't carry `body`, so the lookup misses and `escalation_body` stays null for those rows.

**Placeholder suppression at the data layer.** Spec § B's intent was "if no body, render `—` muted." My first pass left the `escalated via DM; csm=...; dm_ok=...` string in `output_text` as the fallback. Playwright caught it — the pre-deploy Trevor Heck escalation row still showed the placeholder. Fixed by detecting the escalation pattern in `output_summary` and zeroing out the `output_text` fallback for those rows. The cell rendering then naturally falls through to `—` muted.

**Slack link rendering.** The body contains a Slack permalink in `<https://workspace.slack.com/archives/.../p123>` form. The existing `renderSlackText` (mentions + emojis) didn't handle Slack link syntax, so the raw angle brackets would surface in the table cell. Added `stripSlackLinkSyntax` inside the same function — `<url|label>` becomes `label`, bare `<url>` becomes `url`. Consistent treatment across every Output cell.

**Table cell.** Prefers `escalation_body` when present; falls back to `output_text`; renders `—` when both are null.

## Verification

- **TypeScript** — `npx tsc --noEmit` clean.
- **ESLint** — `npx next lint` clean.
- **Playwright** — `scripts/verify-ella-escalation-output.ts` against the preview URL. Three runs total: first failed on harness clip-box being outside viewport; second showed the placeholder still rendering (caught the data-layer suppression gap); third (after suppression fix + harness rewrite) PASS.

### Final Playwright output

```
[verify] /ella/runs: 55 rows
[verify] placeholder string ('escalated via DM') present: false
[verify] body marker ('Worth a look') present: false
[verify] PASS: placeholder suppressed; no body present yet (forward-only — no post-deploy escalation has fired)
```

The first signal is the spec's explicit requirement. The second is a forward-only nature note — until a new passive_monitor → escalate decision fires after this deploy, no row carries a body. The presence of zero `escalated via DM` strings across 55 rows confirms the suppression covered every historical escalation row (which is the row that previously rendered the placeholder).

### Screenshots (in `scripts/.preview/`)

- `ella-escalation-output-full.png` — full `/ella/runs` page. The Trevor Heck escalation row (1d ago) now shows `—` muted in the Output column where it previously showed `escalated via DM; csm=Lou Perez; dm_ok=True`.

## Surprises and judgment calls

- **Spec § A assumed body was in scope at the audit-payload site.** It wasn't — the body local was constructed about 25 lines below. Moved body construction up. The body's inputs (`payload.slack_channel_id`, `payload.triggering_message_ts`, `decision.reasoning`) are all available at function entry, so the move is safe. Net effect: identical body text lands in the audit row and the chat.postMessage call.

- **Placeholder suppression had to happen at the data layer, not the cell.** First pass let the placeholder pass through `output_text`; the cell's `escalation_body ?? output_text` rendered the placeholder when escalation_body was null. Spec wanted `—` muted instead. Fixed by zeroing `output_text` for escalation-pattern rows at the projection level. Cleaner — the placeholder string never leaves the data layer.

- **`renderSlackText` didn't handle Slack link syntax.** Added `stripSlackLinkSyntax` so `<https://...|label>` renders as readable text in any output cell. Affects every output_text and escalation_body across `/ella/runs`, plus the detail page's text. Consistent treatment.

- **Forward-only as visible Playwright state.** The deploy + harness run captured "placeholder gone, body not yet present" — both correct for the current state of the preview's data. Once a new passive_monitor escalation fires (during normal preview activity), the body will appear on that row's Output cell. No backfill in this spec.

- **The webhook_deliveries query strategy.** No prior `payload->>'key'` filter usage in `lib/db/ella-runs.ts`. Picked the safer route: filter by `source='ella_passive_escalation_dm'` + `received_at` time window, then JS-side hash-join by `(channel_id, ts)`. Avoids unknowns about Supabase JSON-key filter performance and indexing. Trade-off: overfetches escalations in the time window, but the volume is tiny (Drake noted total escalations are under 100 historically).

- **getEllaSummaryStats doesn't need the field.** Its projection returns a different type (`EllaSummaryStats`, not `EllaRunsListRow`). No change needed there.

- **Two harness rewrites before passing.** First clip-box error was from screenshot positioning. Second was the harness searching for `escalated` text to find the target row — which my own fix had just suppressed. Rewrote to check page-wide presence/absence of the placeholder string instead of looking for a specific row. More robust and matches the verification intent: "is the placeholder gone everywhere?"

## Out of scope / deferred

- Backfilling historical escalation rows with reconstructed bodies (explicit spec § Out of scope).
- A schema migration to promote `(slack_channel_id, triggering_message_ts)` to indexed columns on `webhook_deliveries` (only if performance becomes a real problem — explicit spec § Out of scope).
- Surfacing the escalation body on the detail page (the spec scopes to list-view; the detail page renders different content via its own paths).
- Drake's gate (c) manual verification once a fresh escalation fires post-deploy: confirm the Output cell renders the body text rather than `—`.

## Side effects

- **Pushed to `gregory-csm-visual-fixes` branch** (NOT main, per spec § Hard stop #1). Four commits in this spec's slice:
  - `7ca6122` — spec cherry-picked from main.
  - `0e4a098` — Python audit-payload + TS data layer + table cell wiring.
  - `b6018a8` — Playwright harness.
  - `0ec81a2` — placeholder-suppression fix + harness rewrite.
- **No DB writes from this run.** Playwright was read-only. The Python change DOES alter what gets written to `webhook_deliveries.payload` going forward (new audit rows carry an additional `body` key), but no rows were written during verification.
- **No new dependencies, no schema changes, no env vars touched.** `webhook_deliveries.payload` is already `jsonb` and accepts arbitrary keys.
- **Status flag left `in-flight`.** Feature branch convention; Drake handles the flip on merge.
- **Local working-tree files preserved** from session start. Two new PNGs in `scripts/.preview/`.
