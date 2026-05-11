# Report: Ella V2 Batch 2.3 post-rollout investigation
**Slug:** ella-v2-batch-2-3-postrollout-investigation
**Spec:** docs/specs/ella-v2-batch-2-3-postrollout-investigation.md

## 1. Files touched

**Created:**
- `docs/reports/ella-v2-batch-2-3-postrollout-investigation.md` — this report.

No other files modified. Investigation-only spec; codebase read-only outside the report file per the spec's hard stop.

## 2. What I did, in plain English

Walked the acclimatization checklist, then read the data per the spec's Issue 1 and Issue 2 investigation steps. Three findings emerged cleanly — no guessing required, all backed by direct queries against cloud Supabase plus reading of `lib/db/ella-runs.ts`.

**Issue 1a (no response to Drake's Javi message): working as designed.** Drake's `slack_user_id=U0AMC23G1SM` resolves to a `team_members` row (`full_name='Drake'`, `is_csm=False`, not archived). The Javi message landed in `slack_messages` with `author_type='team_member'`. The passive-monitor's Gate 2 (author-type) skipped with `skip_reason='non_client_author'`. No Haiku call was made (model/tokens/cost all NULL on the agent_runs row). Per the Batch 2.3 spec § Trigger pipeline.2: "Only `author_type='client'` triggers passive monitoring. Skip team_member / ella / bot / workflow / unknown." Drake's hypothesis (a) confirmed. The CSM-directed-gate framing in the spec was wrong — Drake corrected it before this run, but the data confirms the CSM-directed hypothesis was inapplicable anyway (no `csm_directed` skip; no Haiku call at all).

**Issue 1b (dashboard renders "unknown author / unknown channel"): real bug — `trigger_metadata` key-name drift between reactive and passive paths.** The dashboard's `lib/db/ella-runs.ts` reads `trigger_metadata.channel` (line 303, 371, 533, 568) and `trigger_metadata.real_author_role/name` (line 321-322, 468-469). Those keys are written by the reactive @-mention path's `agents/ella/agent.py:_redact_event` (keys: `channel`, `user`, `ts`, `thread_ts`, `event_ts`, `is_team_test`, `real_author_role`, `real_author_name`, `real_author_id`). But the new passive path's `agents/ella/passive_dispatch.py:persist_passive_evaluation` writes a different shape: `triggering_slack_channel_id`, `triggering_message_slack_user_id`, `triggering_message_ts`, `channel_client_id`, `author_type`, `haiku_decision`, `haiku_reasoning`, `skip_reason`. None of those keys match the dashboard's reads. Every passive_monitor run renders "unknown / unknown" — verified across 2 sampled passive runs (the rendering bug is systematic, not Drake's-message-specific).

**Issue 2 (cost today = $0): real bug — timezone window mismatch.** `lib/db/ella-runs.ts:getEllaSummaryStats` line 491-493 uses `new Date()` then `setHours(0, 0, 0, 0)` to compute `todayStart`. That's server-local midnight; on Vercel the server is UTC. Drake reads "cost today" in EST and expects the EST-midnight window. Cross-check against raw data: UTC-today has 2 ella runs (both Drake's team_member skips with NULL cost) → SUM = $0 (the dashboard is showing the truth for ITS window). EST-today has 10 ella runs totaling $0.2444 — but those 10 include yesterday's 7-11pm EST reactive runs (23:00+ UTC May 10), which sit BEFORE UTC-midnight May 11. Dashboard window is just narrower than Drake expects.

## 3. Verification

### Acclimatization

**Step 1 — env var liveness:** `vercel env ls production` shows `ELLA_PASSIVE_MONITORING_ENABLED` set "3h ago". Most recent prod deploy 3m ago + another 25m ago via `vercel ls --yes`. Env var IS live in the running function. Global kill switch is on.

**Step 2 — per-channel toggle:**
```
channel_id=C0AUWL20U8J name='ella-test-drakeonly' client_id=d1f69a08-9764-4ab8-ac04-94d9986721a0 archived=False passive=True
```
Per-channel toggle IS on.

**Steps 3-5 — read the spec, `agents/ella/passive_monitor.py`, and `lib/db/ella-runs.ts`** before any diagnostic queries. Done; findings below cite specific line numbers.

### Issue 1a (no response): root-cause queries

**Step 1 — Drake's Javi message in `slack_messages`** (channel `C0AUWL20U8J`):
```
id=012bcdac-bb3c-41c3-8efc-fefe9fe23074
slack_ts=1778477901.980929
slack_user_id=U0AMC23G1SM
sent_at=2026-05-11 05:38:21.980929+00:00
author_type='team_member'
text='How can we help Javi sell more'
```

**Step 2 — matching `agent_runs` row** (filter `trigger_metadata->>'triggering_message_ts' = '1778477901.980929'`):
```
id: f389ea14-d5f3-49bd-8156-f4080a4f49cc
trigger_type: passive_monitor  status: success
output_summary: 'skipped (non_client_author): non-client author_type=team_member'
llm: model=None in=None out=None cost=None
trigger_metadata:
{
    "author_type": "team_member",
    "skip_reason": "non_client_author",
    "haiku_decision": "skip",
    "haiku_reasoning": "non-client author_type=team_member",
    "channel_client_id": "d1f69a08-9764-4ab8-ac04-94d9986721a0",
    "triggering_message_ts": "1778477901.980929",
    "triggering_slack_channel_id": "C0AUWL20U8J",
    "triggering_message_slack_user_id": "U0AMC23G1SM"
}
```

**Drake's slack_user_id in `team_members`:**
```
id=489eab6c-aac4-44e8-ab2a-2b5cb28d90e7 slack_user_id=U0AMC23G1SM full_name='Drake' is_csm=False archived_at=None
```
**In `clients`:** zero rows (Drake is not a client — as expected). Drake's identity resolves cleanly to team_member; no ambiguity.

**Recent "Hi Ella can you help me" message (3h ago, 08:09:54 UTC):** same outcome — `skip_reason='non_client_author'`. So this is consistent across Drake's recent tests, not a one-off.

### Issue 1b (unknown author/channel rendering): root-cause comparison

**Passive run `trigger_metadata` keys** (2 most recent passive runs sampled):
```
['author_type', 'channel_client_id', 'haiku_decision', 'haiku_reasoning',
 'skip_reason', 'triggering_message_slack_user_id', 'triggering_message_ts',
 'triggering_slack_channel_id']
```

**Reactive (`slack_mention`) `trigger_metadata` keys** (3 most recent reactive runs):
```
['channel', 'event_ts', 'is_team_test', 'real_author_id', 'real_author_name',
 'real_author_role', 'thread_ts', 'ts', 'user']
```

**Dashboard reads** (`lib/db/ella-runs.ts`):
- `extractTriggerField(trigger_metadata, 'channel')` — line 303, 371, 533, 568. Reactive: ✓ writes `channel`. Passive: ✗ writes `triggering_slack_channel_id`.
- `extractTriggerField(trigger_metadata, 'real_author_role')` — line 321, 468. Reactive: ✓. Passive: ✗ (writes `author_type` instead, which is the SLACK author_type — `client`/`team_member`/`ella` — not the speaker's RESOLVED role).
- `extractTriggerField(trigger_metadata, 'real_author_name')` — line 322, 469. Reactive: ✓. Passive: ✗ (the passive path resolved a speaker on the cron-drain side via `respond_to_passive_trigger`, but the *decision-time* agent_runs row never carries it).
- `extractTriggerField(trigger_metadata, 'thread_ts')` — line 177, 377. Reactive: ✓. Passive: ✗ (passive monitor doesn't preserve thread_ts because passive responses post in main channel by design).

Net effect: every passive_monitor run renders with `channel_name=null`, `channel_client_name=null`, `real_author_role=null`, `real_author_name=null`, AND the surrounding-thread-context query falls through (line 382 requires `ch && thread_ts`, neither resolves for passive runs).

### Issue 2 (cost today = $0): root-cause cross-check

**Raw SUM over UTC-midnight-today window** (the window the dashboard uses):
```
runs_today=2  total_today_cost=$None  earliest=2026-05-11 05:38:24Z  latest=2026-05-11 08:10:03Z
```
Both runs are Drake's team_member skips. NULL cost (no Haiku call). SUM = $0. **Dashboard is showing the truth for its window.**

**Raw SUM over EST-midnight-today window** (the window Drake mentally expects):
```
runs_today_est=10  total_today_est_cost=$0.2444  earliest=2026-05-10 23:08:08Z  latest=2026-05-11 08:10:03Z
```
EST-today catches yesterday-evening-EST Ella reactive runs (~$0.024/run × ~10 runs = ~$0.24) plus today's team_member skips.

**Dashboard code path** (`getEllaSummaryStats`):
```typescript
const now = new Date()
const todayStart = new Date(now)
todayStart.setHours(0, 0, 0, 0)             // server-local midnight
const todayMs = todayStart.getTime()
const cost_today = runs
  .filter((r) => new Date(r.started_at).getTime() >= todayMs)
  .reduce((sum, r) => sum + (r.llm_cost_usd ?? 0), 0)
```
On Vercel server-local IS UTC. So `todayMs` = UTC midnight. Reduce sums the 2 NULL-cost runs → 0. Correct for its window; wrong for Drake's expectation.

**Secondary defensive note:** `r.llm_cost_usd` from Supabase JS for `numeric(10,4)` columns may serialize as STRING rather than NUMBER. `sum + (str ?? 0)` would silently concat strings rather than add numbers. Not currently visible (because today's window has only NULL-cost rows, not string-cost rows) but worth a defensive `Number()` cast when this is fixed.

## 4. Surprises and judgment calls

- **The CSM-directed-gate framing in the spec was already irrelevant before Drake corrected it.** The spec posited `skip_reason='csm_directed'` as "the most likely cause" given the message text mentioned "Javi." Drake corrected via the /run invocation note that Javi is a client, not a CSM. The data confirmed it's neither: Haiku was never called, and the actual skip reason is `non_client_author`. The spec's hypothesis ranking was off (clients-only design is a more fundamental constraint than CSM-directed matching), but it didn't bias the diagnosis — I followed the spec's "diagnose based on `trigger_metadata.skip_reason` and `haiku_decision`" instruction and the data spoke for itself.

- **The passive-monitor `trigger_metadata` key drift is a load-bearing audit-surface bug, but doesn't break anything functional.** Passive runs still execute correctly. The dashboard just renders them blind. Audit traffic is invisible at the channel + speaker layer until Director ships the fix.

- **`real_author_role` and `real_author_name` are partially misleading even for reactive runs.** They reflect *speaker identity resolution* (Batch 1.5), which only fires on @-mention events through `_redact_event`. The passive path's speaker-resolution happens at cron-drain time (`respond_to_passive_trigger` and `handle_passive_general_inquiry`) — it produces `agent_runs` rows with `trigger_type='passive_substantive'` or `'passive_general_inquiry'` that DO carry the resolved-role fields. So the audit dashboard is correct for THOSE rows; it's only the `trigger_type='passive_monitor'` *decision-time* rows that lack them. Worth noting in the fix design so the proposed shape preserves the audit-dashboard's existing accuracy for cron-drain rows.

- **Issue 2 has TWO possible framings.** (a) "Dashboard query window is wrong — use EST midnight to match user expectation." (b) "Display a timezone-aware label like '$X today UTC' so the user knows what window they're seeing." Both are defensible; (a) is what users typically expect from a dashboard built around their workday. Director picks.

- **No production data corruption.** Spec's hard-stop trigger says to stop and surface if `agent_runs` rows have wrong client_id, or escalation DMs fire to the wrong CSM, or similar. Verified the passive runs are RECORDING correctly; the `channel_client_id` and `triggering_slack_channel_id` and other fields are accurate in the database. The bugs are display-layer (Issue 1b) and aggregation-window (Issue 2), not write-layer. No emergency action needed.

- **Issue 1a workaround surface (for Drake's smoke testing).** Three options, none of them clean:
  1. **Drake posts as a client.** Drake doesn't have a Javi-login or any client-account. Requires impersonation rights or a separate "test client" Slack account.
  2. **Remap `#ella-test-drakeonly` to point at a different client** — doesn't help; the gate is on author_type, not channel.
  3. **Add a per-channel "test mode" boolean** that allows team_member messages to trigger passive monitor. Design change worth considering for ongoing dogfooding; behavior would be: Gate 2 is bypassed when `slack_channels.test_mode=true`. Surfaced here for Director to scope, not in scope for this investigation.

## 5. Out of scope / deferred

- **Issue 3 — explaining the five anomaly types (A/B'/C/D/E) on the dashboard.** Per the spec § Issues, "This is a documentation/UX gap, NOT a code bug. Director will write a brief explainer doc separately. Do NOT include in code investigation work." Honored. Director's work; no investigation done here.

- **Mandatory doc updates list** in the spec was explicit: "NONE in this investigation spec — Builder writes only the report." Honored. The fix specs for Issue 1b and Issue 2 will own their own doc-update lists.

- **The "Hi Ella can you help me" message** (08:09:54 UTC, 3h ago) is the same `non_client_author` skip pattern as the Javi message. No new diagnostic data; flagged for completeness above.

- **The "test mode" per-channel design change.** Surfaced under Surprises as a possible Issue 1a workaround for Director to scope.

## 6. Side effects

NONE. All queries were read-only (`SELECT` against cloud Supabase). No writes to `agent_runs`, `slack_messages`, `slack_channels`, `pending_ella_responses`, or any other table. No Slack posts fired. No env vars set. No deploys triggered. Investigation-only spec; the only artifact produced is this report file.

---

## Proposed fix shapes (for Director to scope as separate specs)

### Issue 1a — clients-only passive monitor blocking team-member smoke tests

**File:** `agents/ella/passive_monitor.py:_evaluate` — Gate 2.

**Change:** add an optional bypass for channels flagged as test channels. Two options:

**Option A — per-channel `test_mode` boolean.** New column `slack_channels.test_mode boolean default false`. When `test_mode=true`, Gate 2 accepts `team_member` author_type too. Migration + small code edit. Easy revert: flip the flag.

**Option B — env-var-gated channel allowlist for team_member testing.** `ELLA_PASSIVE_TEST_CHANNEL_IDS=C0AUWL20U8J,...` env var. When the channel id is in the allowlist, Gate 2 accepts team_member. No schema change; deploy-time toggle. Slightly more friction to flip than option A but no migration.

Drake's call between A and B. Director picks.

### Issue 1b — trigger_metadata key-name drift between reactive and passive paths

**File:** `lib/db/ella-runs.ts` — the dashboard query layer.

**Change:** extend `extractTriggerField` callers to read from both reactive AND passive key shapes:
- `channel` OR `triggering_slack_channel_id`
- `real_author_role` OR derive from `author_type` (map `client` → 'client', `team_member` → 'advisor', `ella`/`bot`/`workflow` → 'unknown', `unknown` → 'unresolvable')
- `real_author_name` OR look up via `triggering_message_slack_user_id` against clients/team_members
- `real_author_id` OR similar lookup

Lower-risk alternative: write the bridging fields into the passive-side `trigger_metadata` at write time (`agents/ella/passive_dispatch.py:persist_passive_evaluation`). Adds `channel`, `real_author_*` keys to passive runs so the dashboard's reactive-shape reads work unchanged. Slight redundancy (`channel` duplicates `triggering_slack_channel_id`) but zero dashboard churn.

Either works. The write-side fix is smaller surface; the read-side fix is more durable against future drift.

### Issue 2 — cost-today timezone window mismatch

**File:** `lib/db/ella-runs.ts:getEllaSummaryStats` — line 491-493.

**Change:** compute `todayStart` in Drake's timezone (EST/EDT — `America/New_York`) rather than server-local. Replace:
```typescript
const todayStart = new Date(now)
todayStart.setHours(0, 0, 0, 0)
```
with a timezone-aware computation, e.g. via `Intl.DateTimeFormat` to get the EST/EDT date string and parse back. Or accept a `timezone` parameter and have the page pass the user's preferred timezone.

Defensive numeric cast (separate but cheap): replace `sum + (r.llm_cost_usd ?? 0)` with `sum + Number(r.llm_cost_usd ?? 0)` to guard against Supabase JS returning numeric columns as strings.

The display label can stay "$X today" or shift to "$X today (EST)" for clarity. Director's UX call.

Either Issue 1b or Issue 2 fix could be bundled with the other as a single dashboard-fix spec for the next session, since both touch `lib/db/ella-runs.ts`.
