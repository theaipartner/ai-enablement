# archive/historical

Point-in-time and superseded docs, kept for the record — **not maintained, not current**. The live docs
are in `docs/fulfillment/`, `docs/sales/`, `docs/schema/`, `docs/runbooks/`, and `docs/decisions/`.

## Superseded by the 2026-06-22 fulfillment-doc rewrite
The fulfillment docs were rewritten from current code (see `docs/fulfillment/`). These originals are kept
for history:

- `gregory-conventions.md`, `call_titling.md`, `data-hygiene.md` — consolidated into `docs/fulfillment/conventions.md`.
- `state.md` — the historical shipped-state ledger (migrations + per-batch snapshots, May–June 2026). Git history is the live record now.
- `known-issues.md` — bug/ops-gap log, ~80% resolved entries. A fresh list should be started by the team as new issues arise.
- `future-ideas.md` — the Gregory V2 Batch A–E planning log.
- `client-page-schema-spec.md` — the April 2026 client-page schema blueprint; the migrations + `docs/schema/` are the source of truth now.
- `ella_user_token.md` — discovery output for Ella's user-token posting (shipped; design rationale only).
- `fathom_webhook.md` — the pre-implementation Fathom webhook spec; current behavior is in `docs/fulfillment/architecture.md`.

## Earlier point-in-time artifacts
- `m5_*.md` — M5 client-cleanup diffs and notes (2026-05).
- `gregory-redesign-compiled.md` — compiled redesign working notes.
- `sales-dashboard-v2.html` — a sales-dashboard design mock.
