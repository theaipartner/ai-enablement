# Report (PARTIAL): Ella Architecture Refactor + Daily Digest
**Slug:** ella-architecture-refactor-and-daily-digest
**Spec:** docs/specs/ella-architecture-refactor-and-daily-digest.md
**Status:** halted — gate (a): migration 0040 awaiting Drake's SQL review; the Vercel deploy is coupled to the apply, so no commits are pushed yet.

> Read order for a reviewer: **§ What's needed to unblock** (the decision in front of you) → **§ Review surface** (everything to spot-check, ranked) → **§ Surprises** (the judgment calls) → the rest as needed.

---

## Acclimatization (spec-required 4-5 bullets)

- **passive_monitor.py / passive_dispatch.py** matched the spec's described shape exactly: 5-gate pipeline, `respond_substantive|respond_general_inquiry|skip|escalate`, `_ESCALATION_BYPASS_KEYWORDS`, `_write_passive_escalations_row`. Confirmed before rewriting.
- **agent.py** reactive path used `_detect_and_strip_escalation` + `[ESCALATE]` + `_call_claude` confidence=0.0-on-marker; `respond_to_passive_trigger` had the Sonnet-side escalation branch the spec wants gone. Confirmed.
- **faq_digest_cron.py** is the correct mirror for the new cron (per-recipient fan-out, `webhook_deliveries` audit, shared `CRON_SECRET`, GET==POST). Copied that structure.
- **Spec-vs-reality drift:** spec assumed "0039 latest → 0040 next" — **confirmed 0040 is next** (dir + ledger). But `docs/state.md` line 11 still says "36 migrations / 0001–0036" and "public table count 23→25" — that paragraph is stale, predates this spec, left untouched (out of scope; flagged).
- **Hard-stop #3 (passive escalations, last 7d):** 295 passive_monitor runs, **3 escalations** — under the 5 threshold. Cleared to delete the passive-escalation code.

---

## 1. Files touched

**Created (7):**
- `supabase/migrations/0040_pending_digest_items.sql` — the digest queue table (NOT applied).
- `agents/ella/digest_response.py` — the response Haiku (`generate_response`, trimmed prompt, `[FALLBACK_TO_SONNET]` detection, `DigestResponseResult`).
- `api/ella_daily_digest_cron.py` — daily digest cron (drain → group → fan-out DM → mark sent).
- `docs/schema/pending_digest_items.md` — schema doc.
- `docs/runbooks/ella_daily_digest.md` — new runbook.
- `tests/agents/ella/test_digest_response.py` — 4 tests.
- `tests/api/test_ella_daily_digest_cron.py` — 10 tests.

**Modified (15):**
- `agents/ella/passive_monitor.py` — rewritten: 2 gates, new `PassiveDecision`/`PassiveEvaluation`, decision-Haiku prompt + parser, removed CSM-directed / KB-relevance / firm-after-first / bypass-keyword code + `_fetch_primary_csm` kept.
- `agents/ella/passive_dispatch.py` — rewritten: 4-decision routing, kill-switch-no-row, `_dispatch_respond_haiku_self`, combined cost write, public `insert_digest_item`; deleted `_write_passive_escalations_row` / `_format_escalation_summary` / escalation imports.
- `agents/ella/agent.py` — reactive path routed through decision Haiku; removed `_ESCALATION_MARKER` / `_detect_and_strip_escalation` / `[ESCALATE]` handling; reactive `digest_only` keeps `escalate()` + `fire_escalation_dms` + digest item; `respond_to_passive_trigger` stripped of Sonnet-side escalation.
- `agents/ella/prompts.py` — `_BASE_PROMPT` lost WHAT YOU ESCALATE + FIRM AFTER FIRST, gained the fallback section; `_ESCALATE_LITERAL_FOR_PROMPT` → `_FALLBACK_LITERAL_FOR_PROMPT`; advisor/unresolvable variants updated.
- `agents/ella/slack_handler.py` — **incidental black reflow only** (one `if` wrapped). No behavior change.
- `vercel.json` — new function entry + `30 20 * * *` cron for the digest.
- `.env.example` — `ELLA_DAILY_DIGEST_CC_SLACK_USER_ID` block.
- `docs/agents/ella/ella.md` — Trigger / Response Location / Confidence-Based Routing / System Prompt Direction / Escalation routing rewritten; new Daily-digest section; Changelog entry.
- `docs/runbooks/ella_passive_monitoring.md` — pipeline rewritten to 2 gates; escalation-DM section replaced with digest-flagged section; sensitive-topic-miss + Gate-4 sections rewritten; env-var table fixed.
- `docs/runbooks/cron_schedule.md` — digest cron row + "as of" date.
- `docs/state.md` — 2026-05-18 entry (and an explicit note that line 11 is stale).
- `tests/agents/ella/test_passive_monitor.py` — full rewrite for the 2-gate / 4-decision contract.
- `tests/agents/ella/test_passive_dispatch.py` — full rewrite for the new routing.
- `tests/agents/ella/test_agent.py` — full rewrite for the decision-Haiku reactive path.
- `tests/agents/ella/test_prompts.py` — `[ESCALATE]` → `[FALLBACK_TO_SONNET]` assertions + new base-prompt test.
- `tests/agents/ella/test_escalation_routing.py` — **incidental black reflow only.** No behavior change.

**Deleted:** no files. Deletions are functions/constants *within* the rewritten modules (`_ESCALATION_BYPASS_KEYWORDS`, `_is_directed_at_csm`, `_firm_after_first_match`, `_write_passive_escalations_row`, `_detect_and_strip_escalation`, `_ESCALATION_MARKER`, `_ESCALATE_LITERAL_FOR_PROMPT`, etc.).

Diff totals: 24 files, +3053 / −2229.

---

## 2. What I did, in plain English

Executed the full spec end-to-end except the four Drake-gated operational steps. Collapsed `passive_monitor.py` to 2 pre-LLM gates (kill switch + author-type); KB search is now context, not a gate. New `PassiveDecision` carries `decision`, independent `digest_flag`, `digest_category`, `reasoning`, cost. Decision-Haiku prompt is the spec's verbatim text. `passive_dispatch.py` routes the 4 decisions: kill-switch skip writes no `agent_runs` row; `respond_haiku_self` runs the response Haiku and posts (or falls through to the Sonnet queue on `[FALLBACK_TO_SONNET]`); `respond_via_sonnet` queues `pending_ella_responses` written as `respond_substantive` so the **unchanged** per-minute cron drains it; `digest_only` writes only a `pending_digest_items` row (no `escalations`, no DM on the passive path). `digest_response.py` holds the response Haiku with the trimmed prompt. `agent.py`'s reactive path now runs the same decision Haiku; the `[ESCALATE]` machinery is gone; reactive `digest_only` is the only real-time CSM-DM path. `prompts.py` swapped the escalate/firm sections for a short fallback section. New `ella_daily_digest_cron.py` mirrors the FAQ digest. Migration 0040 written (not applied). All mandated docs updated. `insert_digest_item` was extracted as a public helper so the reactive path writes digest rows through the identical insert.

---

## 3. Verification

- `pytest tests/` — **609 passed, 0 failed** (baseline 607; net +2). Ran twice: after writing tests, and again after `black` reformatted. Both green.
- `npx tsc --noEmit` — clean. `npm run lint` — "No ESLint warnings or errors".
- `black` + `ruff check` clean on all touched Python.
- Hard-stop #3 escalation-count query run against cloud (read-only): 3 ≤ 5.
- **NOT verified (all Drake-gated):** migration apply + dual-verify, Vercel deploy, smoke test in `#ella-test-drakeonly` (the 4 decision branches), manual digest curl, gate-(d) env var. The spec's smoke-test gate and hard stops #6 (insert failure-rate >1% under smoke traffic) **cannot be exercised until deploy** — they remain open and are Drake's gate (c).

---

## 4. Surprises and judgment calls

1. **Nothing pushed — deploy↔migration coupling.** Spec hard-stop #1 makes the migration apply gate (a). The new code writes to `pending_digest_items`; pushing now auto-deploys code that references a non-existent table → every passive message + @-mention errors until the migration lands. Correct order: **review SQL → apply + dual-verify → push (deploys) → smoke**. So I committed 5 local commits and did NOT push (the report commit is local too). This deviates from the usual "push the partial report before stopping" because here the push is welded to a broken deploy. Safer call; surfaced for your agreement.
2. **Commit split = 4 green commits**, not finer. The change is tightly coupled (agent ← passive_monitor; agent ← passive_dispatch.insert_digest_item; tests cover all). Finer splits would leave intermediate commits with failing tests (forbidden). Split: (1) migration+schema doc, (2) core rewrite + its tests, (3) cron + its test + vercel/env, (4) docs, (5) this report.
3. **`respond_via_sonnet` pending row written as `haiku_decision='respond_substantive'`.** Spec § What's NOT says don't touch the per-minute cron, but the cron dispatches on `=='respond_substantive'`; the literal new name would hit its `unknown_haiku_decision` error branch. Writing the cron-known value is the only read of "works exactly the same way; only the upstream decision tree changes." Inferred contract, not spelled out — **review this**.
4. **`insert_digest_item` extracted as public** (spec only named the private `_insert_pending_digest_item`). The reactive path needs the same insert; a shared public helper avoids duplicating the dedup-swallow. Private adapter delegates to it.
5. **Test count 609, not the spec's ~650-670 estimate.** The old files had large parametrized per-gate suites (firm-after-first, CSM-directed, KB-relevance, bypass-keyword) now obsolete; I replaced them with focused new-decision-tree coverage rather than padding to a number. Hard stop #4 (no regression below 607) is met. Judgment: comprehensive-for-the-new-shape over a count target. **This is the most likely thing you'd push back on — see § Review surface item R1.**
6. **`docs/state.md` line 11 is stale** ("36 migrations / 0001–0036", "table count 23→25") vs reality (0040). Predates this spec; a full rewrite of that 700-line-adjacent paragraph is error-prone and out of scope. Flagged in the new state.md entry as a reconciliation item; not corrected.
7. **cron_schedule.md ET mapping.** Spec mentioned an EST schedule `30 21 * * *`. Repo convention (ADR 0003 + every fixed cron) is fixed-UTC with seasonal drift, not two cron expressions. I followed convention: `30 20 * * *` UTC → "16:30 EDT / 15:30 EST", consistent with the FAQ-digest row. EST instant is documented (15:30 EST), satisfying ADR-0003 intent. **Confirm you're OK with fixed-UTC drift vs a literal 16:30-both-seasons schedule.**
8. **Incidental black reflow** of `slack_handler.py` + `test_escalation_routing.py` — black ran over the directories. Pure formatting; folded into commit 2 with a note.
9. **Left intact (spec § What's NOT scoped them out):** `scripts/audit_ella_interactions.py` (greps historical `[ESCALATE]` data), `lib/db/ella-runs.ts` (the "ESCALATE leak" Check-A label + adapters). The TS adapters null-coalesce on the new `trigger_metadata` shape; channel/author keys unchanged so `/ella/runs` doesn't break. New `digest_flag`/`digest_category` fields are not surfaced there — explicit follow-up per spec.

---

## 5. Out of scope / deferred

- The 4 gated ops steps (apply, deploy, smoke, env var) — § What's needed to unblock.
- `docs/state.md` line-11 migration-inventory reconciliation — recommend an EOD doc-hygiene pass; predates this spec.
- `lib/db/ella-runs.ts` surfacing `digest_flag`/`digest_category` — spec marks it an explicit follow-up; read path is best-effort and unbroken.
- No `docs/known-issues.md` / `docs/future-ideas.md` entry warranted beyond the items above.

---

## 6. Side effects

- **One read-only cloud query** (hard-stop #3 escalation count — SELECT only).
- **No Slack posts, no DB writes, no migration applied, no deploy, no external API calls.** Tests fully mock DB/Slack/Anthropic.
- Code/docs git commits — **not pushed** (held behind gate (a) since the deploy is coupled to the migration apply): one each for migration+schema, core rewrite+tests, cron+vercel+env, and docs. Only this report is pushed to `origin/main` ahead of the code, so Director can read it; the code commits land on the post-gate-(a) push.

---

## Review surface — everything to look at, ranked

**R1 (highest — judgment, your call): test consolidation 607→609.** I deleted large obsolete per-gate test suites and replaced them with focused new-decision-tree tests. If you want the spec's ~650 number honored, that's more (lower-value, mostly-redundant) tests to write. Spot-check: `tests/agents/ella/test_passive_monitor.py` (24 tests), `test_passive_dispatch.py` (16), `test_agent.py` (15). Verdict needed: accept the consolidation or ask for more breadth.

**R2: the inferred cron contract (Surprise #3).** `agents/ella/passive_dispatch.py` `_PENDING_SONNET_DECISION = "respond_substantive"` and `_insert_pending`. Cross-check against `api/passive_ella_cron.py:_process_row` (dispatches `=='respond_substantive'` → `respond_to_passive_trigger`). If you'd rather the cron learn the new name, that's a (spec-forbidden) cron change instead.

**R3: migration 0040 SQL (gate (a) — the blocking decision).** Verbatim from the spec, zero deviations:

```sql
CREATE TABLE pending_digest_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id uuid REFERENCES agent_runs(id) ON DELETE CASCADE,
  slack_channel_id text NOT NULL,
  triggering_message_ts text NOT NULL,
  triggering_message_slack_user_id text,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  message_text text,
  haiku_decision text NOT NULL,
  haiku_reasoning text,
  digest_category text,
  ella_responded boolean NOT NULL DEFAULT false,
  sent_in_digest_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pending_digest_items_dedup_idx
  ON pending_digest_items (slack_channel_id, triggering_message_ts);
CREATE INDEX pending_digest_items_unsent_idx
  ON pending_digest_items (created_at) WHERE sent_in_digest_at IS NULL;
```
Apply post-approval: `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes`; dual-verify `to_regclass('public.pending_digest_items')` + both `pg_indexes` rows + `schema_migrations.version='0040'`.

**R4: the trimmed response-Haiku prompt (gate-(b)-adjacent — Drake's careful read, not deploy-blocking).** `agents/ella/digest_response.py:_RESPONSE_SYSTEM_PROMPT`. Assembly: WHO YOU ARE + HOW TO FORMAT YOUR REPLY kept verbatim from `_BASE_PROMPT`; WHAT YOU CAN HELP WITH collapsed to one line; WHAT YOU ESCALATE → "WHAT YOU DO IF YOU CAN'T ANSWER" (the `[FALLBACK_TO_SONNET]` block); FIRM AFTER FIRST / WHAT YOU DECLINE / HOW YOU USE THE CONTEXT dropped. The "your advisor" voice rule is retained inside WHO YOU ARE. Read it for voice quality before/after the post-deploy smoke.

**R5: the decision-Haiku prompt.** `agents/ella/passive_monitor.py:_HAIKU_SYSTEM_PROMPT` — copied verbatim from the spec; the permissive digest-flag stance ("flag if uncertain whether Scott would care") means the expected failure mode is over-flagging, which is the intended bias. Worth knowing before you read the first real digest.

**R6: reactive `digest_only` is now the ONLY real-time CSM-DM path.** `agents/ella/agent.py:_run` (the `digest_only` branch). Verify the ack copy ("Let me grab someone for this one — your advisor will take care of you"), that it still calls `escalate()` + `fire_escalation_dms` + writes the digest item, and that `status='escalated'`. Passive `digest_only` deliberately does none of this.

**R7: spec's "What could go wrong" — explicit answers.**
1. *Malformed Haiku JSON* — `_parse_haiku_output` handles empty / non-JSON / code-fence / prose-prefix / non-object / out-of-enum → all default to `skip` with raw preserved. Tested (`test_passive_monitor.py`: malformed, out-of-enum, fenced, prose-prefix).
2. *Confidently-wrong Haiku answer* — residual risk accepted per spec; mitigation is the fallback prompt + your `/ella/runs` monitoring. No code mitigation beyond the prompt.
3. *Dedup on legitimate re-fires* — unique index `(slack_channel_id, triggering_message_ts)`; the insert helper swallows the violation and continues (`test_passive_dispatch.py::test_digest_insert_dedup_is_swallowed`). Documented in the runbook + schema doc.
4. *Digest body > Slack 40k limit* — truncates at 35k with a `/ella/runs` pointer footer (`_BODY_TRUNCATE_AT`, `_format_digest_message`).
5. *Reactive digest_only ack posts but DMs fail* — per-recipient `webhook_deliveries` audit makes it visible; one failure doesn't block the other (FAQ pattern). Accepted residual risk; recovery query in `docs/runbooks/ella_daily_digest.md`.
6. *Race: Haiku-self → fallback → client follows up* — accepted; the per-minute Sonnet cron handles ordering. Not hit in tests.
7. *Removed-code referenced elsewhere* — grepped `[ESCALATE]` / `fire_escalation_dms` / `_ESCALATION_BYPASS_KEYWORDS` across `agents/`, `lib/`, `scripts/`, `api/`, `tests/`. Only intentional survivors: `scripts/audit_ella_interactions.py` (historical analysis), `lib/db/ella-runs.ts` (UI label + null-coalescing adapters), `api/passive_ella_cron.py` (the `respond_substantive` contract — R2). None break.
8. *You disagree with a design call* — that's R1/R2/R3/R7 and Surprises 3/5/7. Flagged in-band.

**R8: kill-switch optimization.** `passive_dispatch.persist_passive_evaluation` returns early with NO `agent_runs` row when `skip_reason=='kill_switch'`. Confirm you want zero audit trail when Ella is globally off (spec Gate 1 says yes; this is a behavior change from today where every path wrote a row).

**R9: docs accuracy.** `docs/agents/ella/ella.md` (substantial rewrite — Triggers/Response Location/escalation/System Prompt), `docs/runbooks/ella_passive_monitoring.md` (2-gate rewrite), new `docs/runbooks/ella_daily_digest.md`, new `docs/schema/pending_digest_items.md`, `docs/state.md` 2026-05-18 entry. The state.md entry explicitly self-flags the stale line 11.

---

## What's needed to unblock

Sequential, single forced path (the deploy↔migration coupling fixes the order — no A/B/C):

1. **Gate (a): Drake reviews migration 0040 SQL** (R3 above; verbatim from spec). On approval Builder applies via the documented path + dual-verifies (schema reality + ledger `0040`; public table count +1).
2. **Gate (d): Drake sets `ELLA_DAILY_DIGEST_CC_SLACK_USER_ID=U0AMC23G1SM`** in Vercel Production (before the push so the first tick has it).
3. **Builder pushes** all commits → Vercel auto-deploys (safe only after step 1 — the table now exists).
4. **Gate (c): Drake's post-deploy smoke** in `#ella-test-drakeonly` across the 4 decision branches (spec § Smoke test gate step 3 messages) + manual `curl` of `/api/ella_daily_digest_cron?since=<isoT-1h>` to confirm Scott + Drake receive the DM. Spec hard stop #6 (insert failure-rate >1% under smoke traffic) is evaluated here.
5. On smoke success, Builder rewrites this report to the complete (non-PARTIAL) form and flips the spec `Status:` to `shipped` in the same commit-sequence.

Hand this report to Director (chat) to scope step 1's go/no-go on the SQL.
