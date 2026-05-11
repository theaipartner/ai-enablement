# Ella passive monitoring rollout to 7 client channels
**Slug:** ella-passive-rollout-7-channels
**Status:** shipped

## Context

Ella V2 Batch 2.3 (passive monitoring) shipped 2026-05-11 with dual kill switches default OFF. The global env var `ELLA_PASSIVE_MONITORING_ENABLED=true` is already set in Vercel (confirmed live in `#ella-test-drakeonly` via `test_mode=true`). All other channels have `slack_channels.passive_monitoring_enabled=false`.

Drake has validated passive behavior in the test channel and is ready to roll out passive monitoring to the seven production client channels that were the original Batch 1 backfill cohort. Ella was added back to each of these in V1 (reactive `@-mention` mode); passive was held off during validation. This spec flips the per-channel toggle for those 7.

**The 7 client channels.** From state.md's 2026-05-10 Batch 1 backfill cohort, excluding `#ella-test-drakeonly`:

1. Musa Elmaghrabi
2. Javi Pena (production channel — not the test one)
3. Trevor Heck
4. Dhamen Hothi
5. Jenny Burnett
6. Art Nuno
7. Fernando G

Builder must resolve the actual `slack_channels.slack_channel_id` for each via a SELECT against the DB before doing the UPDATE — do NOT hardcode IDs in the spec, and do NOT guess from names.

**Ordering with Drake's heads-up message.** Drake is sending a short heads-up message to each of the 7 channels BEFORE this spec runs. Builder does not run until Drake explicitly says "go" via `/run`. The `/run` invocation IS the confirmation that messages have landed.

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. The current state of `slack_channels.passive_monitoring_enabled` for the 7 listed clients — should all be `false` going in. If any are already `true`, stop and surface to Drake; the cohort assumption is wrong.
2. `slack_channels.test_mode` should be `false` on all 7 (test_mode is `#ella-test-drakeonly`-only by design).
3. `ELLA_PASSIVE_MONITORING_ENABLED=true` confirmed in Vercel env vars — quick sanity check via the Vercel dashboard or by reading `os.environ.get('ELLA_PASSIVE_MONITORING_ENABLED')` from a recent serverless invocation log. If unset or `false`, stop — Drake hasn't flipped it yet and the SQL flip will be a no-op until he does.
4. The 7 client names map cleanly to channels in `slack_channels` via the `clients` table join. Confirm by running the SELECT below; expect exactly 7 rows. If you get fewer or more, surface to Drake — name-matching ambiguity (e.g., two "Fernando" rows) is a Drake-gated disambiguation.
5. The current `pending_ella_responses` queue depth — should be near-zero (only `#ella-test-drakeonly` traffic since 2026-05-11). Note the depth as a pre-rollout baseline.

## Work

### Step 1 — Resolve channel IDs

Run this SELECT against the cloud Postgres (via psycopg2 + the pooler URL, per the working norm in CLAUDE.md):

```sql
select c.full_name,
       sc.slack_channel_id,
       sc.name as channel_name,
       sc.passive_monitoring_enabled,
       sc.test_mode
  from slack_channels sc
  join clients c on c.id = sc.client_id
 where lower(c.full_name) similar to '%(musa elmaghrabi|javi pena|trevor heck|dhamen hothi|jenny burnett|art nuno|fernando)%'
 order by c.full_name;
```

**Expect 7 rows.** If you get more (e.g., two Fernandos, two Javis), or fewer (a name doesn't match), stop and surface the actual rows to Drake. Do NOT pick one yourself.

If the Javi Pena row resolves to `#ella-test-drakeonly` (because that channel was originally Javi-mapped in some configs), exclude it — the test channel must NOT be in the UPDATE. Its `test_mode=true` should make it visually obvious in the SELECT output, but verify by `slack_channel_id` against the value in the runbook (`C0AUWL20U8J`).

### Step 2 — Flip the toggle

Once the 7 rows are confirmed (and the test channel is excluded), run a single transactional UPDATE:

```sql
begin;

update slack_channels
   set passive_monitoring_enabled = true
 where slack_channel_id in (
   -- the 7 resolved IDs from step 1
   '<id1>', '<id2>', '<id3>', '<id4>', '<id5>', '<id6>', '<id7>'
 )
   and passive_monitoring_enabled = false   -- guard: don't re-flip rows already true
   and test_mode = false;                    -- guard: never touch the test channel

-- Confirm exactly 7 rows affected before committing:
-- expect: UPDATE 7

commit;
```

**Hard stop:** if the UPDATE affects fewer or more than 7 rows, ROLLBACK and surface to Drake. Don't commit a partial flip.

### Step 3 — Post-flip verification

Run two reads to confirm the flip landed:

```sql
-- A: the 7 should now be true, test channel and everything else stay false
select slack_channel_id, name, passive_monitoring_enabled, test_mode
  from slack_channels
 where passive_monitoring_enabled = true
 order by test_mode desc, name;
-- expect: 8 rows total (7 new + 1 test channel)
```

```sql
-- B: pre-rollout queue baseline (should still be ~0; the cron picks up new rows within a minute)
select status, count(*)
  from pending_ella_responses
 where created_at > now() - interval '1 hour'
 group by status;
```

### Step 4 — Smoke watch (15 minutes)

Builder does NOT actively monitor for 15 minutes — Builder reports back immediately after the flip with:

- The 7 channel names + IDs flipped (for Drake's confirmation).
- The verification SELECT outputs from Step 3.
- A pointer to `/ella/runs` filtered to `trigger_type=passive_monitor` for Drake to watch over the next 15-30 min as client messages land.

Drake handles the live watch himself — Builder's job ends at the report.

## Hard stops

- **No flip without Drake's `/run` invocation.** Builder is triggered by `/run`, which is the signal that Drake's heads-up messages have landed in all 7 channels. If `/run` fires without that, that's Drake's call to abort.
- **No flip if the global env var is unset or false.** Per the acclimatization check. Stop and tell Drake to flip the env var + redeploy first.
- **No flip if the 7-name SELECT returns ≠ 7 rows.** Surface the ambiguity; Drake disambiguates.
- **No partial commit.** If the UPDATE affects ≠ 7 rows, ROLLBACK. The whole-or-nothing constraint protects against partial-rollout surprise.
- **No touching `#ella-test-drakeonly`.** It already has `passive_monitoring_enabled=true` + `test_mode=true`; leave both alone.
- **No env-var changes.** This spec is SQL-only. Any Vercel env-var work is Drake's gate (d).

## What could go wrong

- **Two channels mapped to the same client.** State.md says some clients had multiple channels (e.g., the `--channel-id` followup mentions "the underlying client maps to multiple channels"). If Musa or Javi has two mapped channels, the SELECT returns 8+ rows. Surface to Drake; don't pick.
- **A client was archived between Batch 1 backfill and today.** The cleanup on 2026-05-05 took 188 non-archived clients; verify none of the 7 are archived. If any are, surface — Drake decides whether to flip the orphaned channel anyway.
- **`passive_monitoring_enabled` already `true` on one or more.** Means someone (maybe Drake during a side-test) already flipped that row. The guard `and passive_monitoring_enabled = false` will silently skip it; the row count will be <7, the hard stop fires, you surface. Drake confirms whether to proceed with the rest.
- **A client posts within the first minute of the flip.** Passive evaluation fires immediately on the next `message` event after the per-channel toggle reads true (the cron re-checks every drain). This is expected behavior, not a bug. The 1-min queue delay still applies before the response posts.

## Mandatory doc updates

- **`docs/state.md`** — append to the Batch 2.3 entry (or add a one-liner under it) noting the 7-channel passive-monitoring rollout date and which 7 channels. Single sentence; the runbook + state.md already carry the architectural detail.
- **No CLAUDE.md change.** This is operational rollout, not a system-state shift.
- **No runbook change.** `docs/runbooks/ella_passive_monitoring.md` already documents the per-channel UPDATE pattern and the validation rollout shape — no edits needed.

## Commit + report

Per CLAUDE.md § Commits, one logical change here is the state.md edit + the report; the SQL flip itself isn't a code change so it doesn't get its own commit. Suggested:

- `docs: log Ella passive rollout to 7 channels in state.md`
- `docs: add report for ella-passive-rollout-7-channels`

Report at `docs/reports/ella-passive-rollout-7-channels.md`. Include:

- The 7 names + resolved `slack_channel_id` values.
- Pre-flip and post-flip state of `passive_monitoring_enabled` on each.
- Pre-rollout `pending_ella_responses` queue baseline.
- The verification SELECT outputs.
- Any anomalies surfaced during acclimatization (name mismatches, already-true rows, etc.) and how Drake resolved them.
- A pointer for Drake: "watch `/ella/runs` filtered to `trigger_type=passive_monitor` over the next 15-30 min for the first decisions from each channel."
