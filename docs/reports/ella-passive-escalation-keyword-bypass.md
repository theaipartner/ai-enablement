# Report: Add escalation-keyword bypass to Ella passive monitoring Gate 4

**Slug:** ella-passive-escalation-keyword-bypass
**Spec:** docs/specs/ella-passive-escalation-keyword-bypass.md

## Files touched

**Modified**
- `agents/ella/passive_monitor.py` — added `_ESCALATION_BYPASS_KEYWORDS` frozenset (5 categories — money / complaints / crisis / quitting / legal) and `_has_escalation_bypass_keyword(message_text)` helper (case-insensitive substring scan, returns the matched keyword or None). Wired into `_evaluate`'s Gate 4 block: when `relevant_chunks` is empty AND `bypass_keyword is None` the gate still skips (existing behavior preserved); when the bypass keyword fires the gate lets the message through to Gate 5 + Haiku with an empty `relevant_chunks` list. The `bypass_keyword` is plumbed onto Gate 5's skip path AND the Gate 6 Haiku-decision return so audit data follows the message regardless of which downstream branch fires. New field `PassiveEvaluation.bypass_keyword: str | None = None` (frozen dataclass — defaulted-field addition is backward-compatible per the spec).
- `agents/ella/passive_dispatch.py` — `persist_passive_evaluation` reads `evaluation.bypass_keyword` and writes `trigger_metadata.kb_relevance_bypass_keyword` when non-None. Field is omitted entirely when unset so audit queries can use `trigger_metadata ? 'kb_relevance_bypass_keyword'` to count bypass-fired runs without false positives.
- `tests/agents/ella/test_passive_monitor.py` — added 7 tests in a new "Gate 4 — escalation-keyword bypass" block: bypass with no KB chunks reaches Haiku → escalate (the headline failure case), bypass with KB chunks still records the keyword for audit, control case (no keyword + no KB chunks still skips at Gate 4), case-insensitivity across CANCEL/Cancel/cancel variants, multi-word phrase matching ("money back"), and a parametrized 5-case test covering one keyword from each category. New `_stub_haiku_escalate` test helper.
- `tests/agents/ella/test_passive_dispatch.py` — added 2 plumbing tests: bypass_keyword lands in trigger_metadata under `kb_relevance_bypass_keyword`; None bypass omits the field entirely. Also extended `_payload` to accept a `text` kwarg so the bypass test can vary the message body.
- `docs/agents/ella/ella.md` — § Trigger now references the Gate 4 bypass; new "Gate 4 escalation-keyword bypass (2026-05-14)" paragraph immediately after the gate enumeration describes the categories, the route-to-Haiku-not-auto-escalate semantics, the audit field, and the substring-match decision.
- `docs/runbooks/ella_passive_monitoring.md` — new "Gate 4 silently dropping an escalation-worthy message" troubleshooting section after the existing Sensitive-topic-miss section, with the bypass-fired-runs SQL query.
- `docs/state.md` — new top-line entry under "Gregory editorial skin shipped" describing what shipped (motivation, categories, plumbing, test count, hard stops honored).

**Created**
- None. Spec was code-edit-shape only; no new modules, tests, or doc files.

## What I did, in plain English

Added a five-category keyword list to `passive_monitor.py` that protects against the failure mode where escalation-worthy messages (cancellation intent, refund demands, frustration, crisis language, legal threats) get silently dropped at the KB-relevance gate because they have no curriculum anchor. The bypass scans the message text on a case-insensitive substring match; on a hit, Gate 4 lets the message through to Haiku even when zero KB chunks pass the 0.30 cosine threshold. **Bypass routes to Haiku — it does NOT auto-escalate.** Haiku still makes the final escalate/skip/respond decision; the keyword presence only decides whether Haiku gets to look. The matched keyword flows through a new `PassiveEvaluation.bypass_keyword` field onto `agent_runs.trigger_metadata.kb_relevance_bypass_keyword` so `/ella/runs` surfaces which trigger fired and production data drives iteration of the keyword list.

The keyword list deliberately overshoots — false positives ("cancellation policy" matches "cancel") are acceptable because the cost is one extra Haiku call (~$0.001) that correctly returns "skip." The cost of a missed escalation is qualitatively much worse. The list lives as a single Python frozenset constant per the spec's explicit "no config table / no env var in this spec" hard stop; iteration is via PR.

The fix was framed exactly as the spec asked: bypass for Gate 4 only (Gates 1, 2, 3, 5 still run as before — a kill-switch-off channel doesn't suddenly fire Haiku because of a keyword), no auto-escalation, no Haiku prompt edit, no threshold lowering, no migrations.

## Verification

- `pytest tests/` → **537 passed, 0 failed** (was 525 pre-spec; net +12: 7 new bypass-behavior tests in `test_passive_monitor.py` + 2 plumbing tests in `test_passive_dispatch.py` + 3 parametrized sub-cases from the per-category test).
- `pytest tests/agents/ella/test_passive_monitor.py tests/agents/ella/test_passive_dispatch.py` → 41 passed, exercising the bypass on the headline "no KB chunks" case, the "KB chunks present" case (bypass still records keyword), the control "no keyword + no KB" case (existing skip preserved), case-insensitivity, multi-word phrase matching, and one keyword from each of the five categories.
- The three production smoke-test failure modes from 2026-05-14 ("I want my money back" / "give me my god damn money back" / "I'm really frustrated, I want to talk about canceling my account") all now route through the bypass on the relevant keywords (`my money` / `money back` / `frustrated` / `canceling`); Haiku's existing escalate fence (`_HAIKU_SYSTEM_PROMPT`) already covers all five categories so the decision should be `escalate`. Production confirmation is gate (c) — Drake validates by re-posting one of those messages in `#ella-test-drakeonly` and confirming the `agent_runs` row carries `kb_relevance_bypass_keyword` + `haiku_decision='escalate'`.

## Surprises and judgment calls

- **`bypass_keyword` flows through Gate 5 firm-after-first AND Gate 6 Haiku-decision paths, not just one.** First pass only stamped it on the Gate 6 return; I caught while re-reading that a bypass-fired message that THEN gets blocked by firm-after-first would lose the audit data. Plumbed onto Gate 5's PassiveEvaluation return too. Worth flagging because audit queries that count bypass-fired runs will see the firm-after-first ones included — that's correct (we want to know the message reached Gate 5, not just Gate 6).
- **Field omitted entirely when None, not written as null.** The spec says `kb_relevance_bypass_keyword=<matched_word>` when the bypass fires; I interpreted that as "only when fired." The dispatch-side test pins this so audit queries with `trigger_metadata ? 'kb_relevance_bypass_keyword'` count bypass-fired runs cleanly. Alternative would have been always writing `bypass_keyword: null` on every passive run, which would make `?` checks useless and force every audit query to use `IS NOT NULL`. Single-line difference; flagging in case Drake wants the other shape.
- **`_has_escalation_bypass_keyword` iterates a frozenset, returning the first match.** Frozenset iteration order isn't deterministic across Python runs, so when a message contains BOTH "money back" AND "my money" the returned keyword is whichever frozenset.__iter__ yields first. Test asserts `in {"money back", "my money"}` rather than pinning a specific one. The audit field is single-keyword; not a problem in practice because we want "a bypass fired and here's one of the matching keywords for context." If Drake later wants the full set, the field type changes to `list[str]` and the dispatch-side serialization changes.
- **Case-insensitivity via `text.lower()` + lowercase keyword constants.** Simple and correct. The frozenset is hand-typed lowercase; no normalization helper needed. Variant test passes.
- **The keyword list overshoots deliberately.** I included "dispute" and "agreement" which can have benign meanings (a client disputing a CSM's interpretation of a framework, a verbal agreement to try something). Both fall in the money/commitment category in the canonical sense ("payment dispute" / "service agreement") and the false-positive cost is one Haiku call. Kept them in. If iteration shows these fire too noisily in production, drop them and add the prod-observed phrasings instead.
- **The spec mentioned "Option B" (encode the keyword in `PassiveDecision.reasoning` as a prefix) as an alternative to Option A (explicit field).** I went with A as the spec leaned. Cleaner to query, no parse-prefix logic, structured audit. Option B would have worked too but felt subtly worse.
- **No changes to `_HAIKU_SYSTEM_PROMPT`.** Spec § Hard stops says "Don't touch Haiku's prompt." Honored. Haiku's existing auto-escalate fence already covers all five categories of the keyword list.

## Out of scope / deferred

- **Production validation in `#ella-test-drakeonly`.** Gate (c) — Drake re-posts one of the original three failed smoke-test messages and confirms `/ella/runs` surfaces the run with `kb_relevance_bypass_keyword` populated + Haiku decision `escalate`. Until Drake validates, the keyword list is "should work" not "verified working."
- **Tuning the keyword list from production data.** Per the spec's "What could go wrong" section, the list is the conservative starter set. The audit-query in the runbook surfaces bypass-fired runs; iterate the list in a follow-up spec when there's a body of production examples (false positives Haiku correctly skipped, false negatives that should have triggered bypass but didn't).
- **Moving the keyword list to a config table or env var.** Spec § Hard stops explicitly defers this. Single Python constant for now; promote later if iteration becomes painful.
- **Lowering `ELLA_PASSIVE_KB_RELEVANCE_THRESHOLD` from 0.30.** Spec § Hard stops explicitly defers this. Bypass is the right lever for the escalation case; the threshold stays where it is for non-keyword messages.
- **Gate-naming cleanup.** Spec § Decisions called out that `trigger_metadata.haiku_decision` is populated even when Haiku didn't run, which is misleading. Out of scope here; separate cleanup.

## Side effects

- **Two commits pushed to `main` this session** (`3214f59` feat, `97db386` docs). Report commit lands next.
- **No real Slack posts or DB writes during pytest** — the autouse `_block_real_slack_posts` conftest fixture covers it, and `passive_monitor.complete` is stubbed in every bypass test.
- **Vercel auto-deploys on push.** Post-deploy, the 7 production passive-monitored client channels will begin routing context-thin escalation-worthy messages through to Haiku instead of skipping at Gate 4. Existing benign passive runs are unaffected — the bypass only changes behavior when the keyword list matches AND KB is thin; in every other case Gate 4 fires as before. The keyword bypass slightly increases Haiku spend on benign-but-keyword-matching messages (e.g. "cancellation policy" questions); the spec accepted this trade-off as ~$0.001 per extra Haiku call.
- **No env var added** — keyword list lives in code per spec § Hard stops. `ELLA_PASSIVE_KB_RELEVANCE_THRESHOLD` is unchanged at 0.30.
- **No migrations** — `agent_runs.trigger_metadata` is a jsonb column; the new key needs no schema change.
