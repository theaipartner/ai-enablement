# Shipped Note: Ella @-Mention Structural Override
**Slug:** ella-at-mention-structural-override (shipped 2026-05-19 late PM)
**Pairs with:** `docs/reports/ella-at-mention-structural-override.md` (PARTIAL — left intact as the audit-trail body of record)

## Outcome

Drake's gate (c) smoke in `#ella-test-drakeonly` confirmed the structural override works as designed: "Working like it should." All six smoke cases passed, including cases 1-3 (the v1/v2 regression cases — bare `<@Ella>` from advisor with stale/resolved context, bare mention in quiet channel, KB-answerable @-mention question). The classifier-bypass schema closed the failure mode that three iterations of prompt-only fixes could not.

Spec `Status:` flipped `in-flight` → `shipped` in the same commit as this note. `ella-passive-monitoring-default-on` is now unblocked.

## Audit trail (this slug)

- `docs/specs/ella-at-mention-structural-override.md` — spec, `shipped`.
- `docs/reports/ella-at-mention-structural-override.md` — PARTIAL report (full implementation detail, gate-(c) handoff).
- `docs/reports/ella-at-mention-structural-override-shipped.md` — this note (smoke-pass confirmation).

Three prior slugs in the same arc (smoke-pass / regression-fix lineage):
- `ella-decision-haiku-prompt-sharpening` v1 (PARTIAL) → `…-smoke-diagnostic.md` (failure findings).
- `ella-decision-haiku-prompt-sharpening` v2 (PARTIAL).
- This spec (structural override) — supersedes the prompt-only v1/v2 fixes.

Pre-existing out-of-scope `ruff` item in `tests/agents/ella/test_agent.py` remains untouched (documented across the prior three reports).
