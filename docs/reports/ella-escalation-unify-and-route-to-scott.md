# Report (PARTIAL): Unify Ella escalation paths (reactive + passive) and route to Scott + primary CSM

**Slug:** ella-escalation-unify-and-route-to-scott
**Spec:** docs/specs/ella-escalation-unify-and-route-to-scott.md
**Status:** halted — gate-(b) hard stop on prompts.py edit awaiting Drake's diff approval

## Files touched

**Created**
- `agents/ella/escalation_routing.py` — new shared module: `resolve_escalation_recipients(primary_csm)` + `fire_escalation_dms(...)`. Owns the recipient list (Scott via env var + primary CSM, dedup'd, Scott-first), the DM body shape (`:eyes: Worth a look — <link>\n_Ella escalated this. Reasoning: <≤200 chars>_`), the Slack permalink helper, and the `webhook_deliveries` audit rows under the unified `source='ella_escalation_dm'`.
- `tests/agents/ella/test_escalation_routing.py` — 11 tests covering recipient resolution (5 env/primary-csm combos + 1 lookup-failure fallback) and DM fan-out (2-recipient success, mixed success/failure, empty-list noop, 200-char truncation, workspace permalink).

**Modified**
- `agents/ella/passive_dispatch.py` — escalate branch now calls `agents.ella.escalation.escalate()` to write an `escalations` row (was: never did) AND delegates DM fan-out to `fire_escalation_dms(..., path="passive")`. Removed: the legacy `_fire_escalation_dm`, the inline permalink builder, the inline audit helpers, and the audit source label `'ella_passive_escalation_dm'` constant. Terminal `agent_runs.status` now flips to `'escalated'` (matches the reactive path) when the escalations row writes, else stays `'success'`. New `output_summary` shape: `"escalated via DM; Scott=ok, Lou Perez=ok; escalation_id=<id>"`.
- `tests/agents/ella/test_passive_dispatch.py` — replaced the three escalation-branch tests with three new ones matching the unified shape: (1) writes escalations row + fans out to Scott + primary CSM under the renamed audit source, (2) no primary CSM but Scott configured → DMs Scott only, (3) safer floor — neither env var nor primary CSM → no DMs, escalations row still writes, `no_recipients` recorded in output_summary. Added `is_` to the chain stub and extended the fake DB to handle `escalations` insert + `client_team_assignments` / `team_members` selects.
- `tests/conftest.py` — autouse `_block_real_slack_posts` patches `agents.ella.escalation_routing.post_message` instead of `agents.ella.passive_dispatch.post_message` (the latter is no longer a bound name since passive_dispatch delegates DM sends through the new module).
- `lib/db/ella-runs.ts` — `fetchEscalationBodies` filter changed from `.eq('source', 'ella_passive_escalation_dm')` to `.in('source', ['ella_passive_escalation_dm', 'ella_escalation_dm'])` so historical rows still surface their bodies alongside the renamed source. Inline comments updated to reflect the unification.
- `.env.example` — added `ESCALATION_RECIPIENT_SLACK_USER_ID` block with rationale ("Slack user_id of the head CSM (Scott today) who receives a DM on every Ella escalation … Unset safely degrades: only the primary CSM is DMed, with a logged warning; escalations still write to the `escalations` table either way").

**Not yet touched (gated on prompt-diff approval)**
- `agents/ella/agent.py` — reactive `_run` needs `fire_escalation_dms(..., path="reactive")` after `escalate()`. Sonnet-side passive escalation in `respond_to_passive_trigger` similarly needs the fan-out.
- `agents/ella/prompts.py` — `_BASE_PROMPT` § WHAT YOU ESCALATE: replace the paragraph instructing Sonnet to write `<@U…>` in the ack + drop the mention from the example shape. Proposed diff surfaced in chat above. **This is the gate.**
- `tests/agents/ella/test_agent.py` — extend existing escalation tests to assert `fire_escalation_dms` is called with `path="reactive"` + the client-facing ack no longer contains a `<@U…>` mention.
- `docs/agents/ella/ella.md` — Escalation behavior section needs the new unified shape described.
- `docs/runbooks/ella_passive_monitoring.md` — "Backend escalation DMs" SQL query and § Env vars table need to reference the new env var + dual-source filter.
- `docs/state.md` — new entry under "Gregory editorial skin shipped" describing what shipped.

## What I did, in plain English

Built the shared `escalation_routing` module that both Ella escalation paths will route through and rewired the passive path to use it. The passive escalate branch now writes an `escalations` row (closing the persistence gap — passive previously wrote only `agent_runs` + audit), then fans DMs out to Scott (`ESCALATION_RECIPIENT_SLACK_USER_ID`) plus the channel's primary CSM with dedup when Scott IS the primary CSM. The audit source label was renamed `ella_passive_escalation_dm` → `ella_escalation_dm` so the same label covers both paths post-cutover; the dashboard's body-fetcher now accepts both labels so historical rows survive the rename. Test coverage for the new module is fresh (11 tests); the three passive-dispatch escalation-branch tests were rewritten to match the unified shape.

The reactive-path wiring and the prompt edit (drop the `<@advisor>` mention from the client-facing ack — backend DMs replace the in-channel ping) are intentionally not landed yet because the spec § Hard stops marks the prompts.py edit as gate-(b): "surface the proposed prompt diff to Drake."

## Verification

- `pytest tests/agents/ella/test_escalation_routing.py tests/agents/ella/test_passive_dispatch.py` → **20 passed**.
- `pytest tests/` (full suite) → **524 passed, 0 failed**. The +12 over the pre-spec baseline (512) is: +11 new `test_escalation_routing.py` tests + 1 net from the rewrite of the three escalation-branch tests in `test_passive_dispatch.py` (3 deleted, 3 added, plus one safer-floor case). No other test changed.
- `lib/db/ella-runs.ts` TypeScript change is structural (`in` filter accepting an array); no TS compile verification was done in this session — Vercel will exercise it on deploy.

## Surprises and judgment calls

- **Sonnet-side passive escalations also need the fan-out.** `agents/ella/agent.py:respond_to_passive_trigger` handles the case where Haiku decided "respond" but Sonnet's generation emits `[ESCALATE]` mid-flight. That branch already writes an `escalations` row via `escalate()` but fires no DMs today. The spec doesn't call it out explicitly, but "all escalations go through the same fan-out" means it has to. Plan is to wire `fire_escalation_dms(..., path="passive")` there alongside the reactive wiring in `_run`. Flagging because the spec talks about two paths; there are arguably three.
- **`agent_runs.status` flip from `'success'` to `'escalated'` on passive escalations.** The passive `_fire_escalation_dm` used to set `status='success'` because no escalations row was being written. With the unified write, I align with the reactive path's `status='escalated'` so the dashboard's response-scope filter treats them identically. The dashboard already accepts both statuses (`['success', 'escalated', 'error']`) AND the `passive_monitor` rows pass the scope filter via `haiku_decision === 'escalate'` regardless of status, so no rendering shift.
- **`output_summary` format change.** Was `"escalated via DM; csm=<name>; dm_ok=<bool>"` (one CSM); now `"escalated via DM; <label1>=ok/fail, <label2>=ok/fail; escalation_id=<id>"` (N recipients + escalation id). Still starts with `escalated via DM` so the dashboard's `ESCALATION_PLACEHOLDER_PATTERN = /^escalated via DM/i` still matches and the body-suppression path keeps working.
- **N audit rows per escalation, not 1.** The new shape emits one `webhook_deliveries` row per recipient. The dashboard's body-fetch keys by `(slack_channel_id, triggering_message_ts)` so multiple rows with the same join key resolve to the same body (the body is identical across recipients in a single escalation event). Confirmed by inspection — no rendering bug, but worth flagging for anyone querying audit volume.
- **Conftest patch swap, not addition.** The autouse `_block_real_slack_posts` had `agents.ella.passive_dispatch.post_message` in its monkeypatch list. After this refactor, `passive_dispatch` no longer imports `post_message` directly, so that path is no longer a bound name — patching it would raise `AttributeError`. Replaced with `agents.ella.escalation_routing.post_message`. The other patch (`shared.slack_post.post_message` direct) stays.
- **Recipient-list dedup semantics.** When Scott IS the channel's primary CSM, the recipient list collapses to one entry tagged `source='scott'` (the head-CSM concern wins in the audit trail). The alternative — tag as `primary_csm` — felt subtler and harder to reason about. Tests pin this; if Drake wants the other shape it's a one-line flip.

## Out of scope / deferred

- The reactive-path wiring + prompt edit + test_agent.py extension + doc updates land in the resume pass after Drake approves the diff.
- The 137 master-sheet-seed clients sticky-override gate is unrelated and stays as-is.
- No migrations added. Spec § Hard stops forbids it; confirmed no schema change needed.

## Side effects

- **No real Slack posts fired during pytest.** The autouse conftest mock is intact and the new `escalation_routing.post_message` path is monkeypatched. Verified by the 524-pass suite running clean with no Slack network activity.
- **No DB writes outside test fakes.** Every `get_client()` call in tests routes through `_FakeDb`.
- **No production deploys.** Nothing pushed yet; everything is in the local worktree.

## What's needed to unblock

Drake's approval (or counter-proposal) on the proposed `prompts.py` diff surfaced in chat. Three plausible Drake responses, all easy to handle:

- **A — Approve as-shown.** I apply the prompt edit, wire reactive `_run` + `respond_to_passive_trigger`'s escalate branch with `fire_escalation_dms`, extend `test_agent.py`, finish the doc updates (`docs/agents/ella/ella.md`, `docs/runbooks/ella_passive_monitoring.md`, `docs/state.md`), run pytest, commit (one feature commit + one docs commit + report commit), push, overwrite this partial with the complete report.
- **B — Approve with wording tweaks.** Same execution flow, just with the substituted wording in the prompt.
- **C — Push back on shape.** Most likely sub-thread: keep the in-channel mention even though it double-pings (one ping in channel, one in DM). I'd argue against — the whole point of the new DM is reliable notification, the in-channel mention then becomes redundant — but if Drake prefers the double-ping (e.g., as a redundancy belt-and-suspenders during rollout) I can leave the prompt untouched and just wire the DM fan-out. The escalations table would still get its row either way.

Default lean: A. The diff is tight, surgical, and follows directly from the design.
