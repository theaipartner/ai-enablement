# Report: Ella V2 Batch 1 — finish operational rollout

**Slug:** ella-v2-batch-1-finish-rollout
**Spec:** docs/specs/ella-v2-batch-1-finish-rollout.md

## Files touched

**Modified:**
- `scripts/backfill_slack_client_channels.py` — softened `bot_not_in_channel` from hard-stop (returning 4) to log-and-continue; added per-error-type breakdown in summary; split exit semantics so `bot_not_in_channel` alone returns 0 while other errors return 1; updated module docstring.
- `docs/runbooks/slack_message_ingest.md` — rewrote the `bot_not_in_channel` failure-mode entry to reflect the new behavior; added a new "client has multiple channels and only one backfills" failure-mode entry pointing at the `extra_channel_names` workaround.
- `CLAUDE.md` — appended the 2026-05-10 operational rollout result to the § Live System State Batch 1 entry (3,641 rows, live ingestion not yet operational, both surfaced gaps tracked in `docs/known-issues.md`).
- `docs/known-issues.md` — two new entries: (1) Ella V2 Batch 1 realtime live ingestion not operational, awaiting Drake's Slack-app-config check; (2) backfill `--channel-id` flag doesn't strictly scope when a client owns multiple channels.

**Created:**
- This report (`docs/reports/ella-v2-batch-1-finish-rollout.md`).

## What I did, in plain English

Three sequential tasks, executed in order per the spec.

**Task 1 (script change).** Replaced the `bot_not_in_channel` hard-stop with log-and-continue; the affected channels now print as `[SKIPPED]` rather than `[ERROR]` (visual nudge that this is a known operational state, not a fault), and the end-of-run summary prints a per-error-type count like `Errors: 3 (bot_not_in_channel: 3)`. Exit-code semantics intentionally split: `bot_not_in_channel`-only runs return 0; any other error type (network, auth, rate-limit) still returns 1. Updated the module docstring inline so the file's own description doesn't drift.

**Task 2 (8-channel backfill).** Pre-verified all 8 channels have `slack_channels.client_id` populated and `is_archived=false`. Smoke-ran one channel (Musa Elmaghrabi / C09FA7EQRDL → 472 messages, 14 API calls, clean author breakdown). Then ran `--apply --channel-id <id>` for each of the 8 sequentially. Seven succeeded straightforwardly. The 8th (`C0AUWL20U8J`, ella-test-drakeonly) revealed a script-design subtlety I describe in Surprises below; recovered with a direct call to `run_ingest` using `extra_channel_names=["ella-test-drakeonly"]`, which goes through `_resolve_channel_name_target` (Slack API lookup by name) and ingests the specific channel without touching the co-tenant `C09GA380JRM`. Final per-channel counts:

| channel | client | rows | min_sent_at | max_sent_at |
|---|---|---:|---|---|
| C09FA7EQRDL | Musa Elmaghrabi | 472 | 2026-02-10 | 2026-05-10 |
| C09GA380JRM | Javi Pena | 333 | 2026-02-09 | 2026-05-08 |
| C0AUWL20U8J | ella-test-drakeonly (Javi Pena) | 69 | (see below) | (see below) |
| C0AEEPVK36W | Trevor Heck | 716 | 2026-02-11 | 2026-05-10 |
| C0AFEC456JG | Dhamen Hothi | 642 | 2026-02-16 | 2026-05-10 |
| C0AF40ARZHD | Jenny Burnett | 403 | 2026-02-17 | 2026-05-10 |
| C0AQQFG5UEP | Art Nuno | 596 | 2026-04-04 | 2026-05-10 |
| C09TYEPLGBX | Fernando G | 410 | 2026-02-09 | 2026-05-10 |

Total: 3,641 rows across 8 channels; `slack_messages` total-table count matches exactly. `C09GA380JRM` stayed pinned at 333 after the `C0AUWL20U8J` recovery, confirming no cross-channel contamination.

**Task 3 (live-ingestion verification).** Pre-test baseline: `webhook_deliveries WHERE source='slack_message_ingest'` count was 0, `slack_messages` total was 3,572 (post-Task-2 before the C0AUWL20U8J recovery). Drake posted "Hi Ella" in `#ella-test-drakeonly` (Slack-side ts `1778440700.434379`, sent 2026-05-10 19:18:20 UTC). Verified independently via `conversations.history` that Slack has the message. Verified independently via `conversations.members` that the bot (`U0ATX2Y8GTD`) IS in the channel. Confirmed the endpoint is alive (GET → 200, unsigned POST → 401 with `invalid signature`). Polled `webhook_deliveries` for 40+ seconds spanning 15-plus minutes after the post — zero rows. **Live ingestion is NOT operational.** The cause is upstream of our handler (Slack isn't delivering events at all), so it falls under Drake's gate (d) per the spec; I diagnosed but did not attempt to fix. Two probable causes laid out in `docs/known-issues.md` for Drake to walk through — Event Subscription state, app reinstall after scope change, signing-secret env var, or a 4xx-disabled subscription.

## Verification

- **Syntax + import:** `python -m py_compile` clean on the modified script. Imported via `python -c` — no import errors.
- **Adjacent pipeline tests:** `pytest tests/ingestion/slack/test_pipeline.py -q` → 13/13 passing (unchanged paths, but they cover the surfaces my edit is adjacent to).
- **Real-API smoke:** `--smoke --channel-id C09FA7EQRDL` → 472 messages, 14 API calls, exit 0. End-to-end pipeline verified against real Slack + real cloud DB before any `--apply`.
- **Backfill apply:** 8 channels processed; per-channel insert counts verified by direct query against `slack_messages`. Totals reconciled (per-channel sum = full-table count = 3,641).
- **Cross-channel non-contamination:** `C09GA380JRM` row count stayed at 333 across the entire run, including after the C0AUWL20U8J recovery — confirming the `extra_channel_names` path scoped cleanly.
- **Live-ingestion diagnostic:** four independent checks (`webhook_deliveries` poll, `slack_messages` poll for C0AUWL20U8J, `conversations.history` confirming Slack has the message, `conversations.members` confirming bot membership). All pointed at the same finding.

I did not run the full pytest suite. The change is contained to `scripts/backfill_slack_client_channels.py` and three docs; no tests exist on the script itself, and the underlying pipeline tests are unaffected. If you want a full-suite run before the next iteration, say so and I'll kick it.

## Surprises and judgment calls

**The `--channel-id` flag doesn't actually scope to one channel when the client owns multiple.** `_fetch_client_channels` in the script filters `slack_channels` by `slack_channel_id`, but the lookup output is reduced to a list of `client_full_names`, which `run_ingest` then re-resolves via `_resolve_client_target` — which picks the first channel returned for that client by `select * from slack_channels where client_id = X`. So `--channel-id C0AUWL20U8J` ended up re-running `C09GA380JRM` instead. Caught it because the per-channel apply for `C0AUWL20U8J` printed `inserts=0 updates=333` and the channel label said "Javi Pena (C09GA380JRM)" instead of "ella-test-drakeonly (C0AUWL20U8J)". Drake confirmed in chat that this co-tenant situation is deliberate (`#ella-test-drakeonly` lives in Javi's workspace with Javi as the client mapping). Worked around it for this spec by calling `run_ingest` directly with `extra_channel_names=["ella-test-drakeonly"]`; the longer-term followup is logged in `docs/known-issues.md`.

**The spec's Task 3 channel ID was wrong.** Spec said "post in `#ella-test-drakeonly` (channel `C09GA380JRM`)". Reality from `slack_channels`: `C09GA380JRM` is named "Javi Pena" (production), and the real `#ella-test-drakeonly` is `C0AUWL20U8J`. I flagged this in chat before Task 3 and Drake confirmed `#ella-test-drakeonly` is the right channel. Mentioning here so a future spec author or runbook reader doesn't propagate the misstated id.

**Author-type ingestion working.** The C0AUWL20U8J backfill author breakdown was `{'team_member': 43, 'ella': 5, 'bot': 21}` — the 5 `ella`-tagged posts confirm `shared.slack_identity` + the parser's Ella branch are operating end-to-end. The other client channels showed only `client / team_member / bot / unknown` author types — Ella isn't a member of those (the V1 pilot is only in `#ella-test-drakeonly`), which is consistent with the CLAUDE.md state.

**The "duplicate Javi Pena" question from the spec is resolved.** Both `C09GA380JRM` and `C0AUWL20U8J` are legitimate distinct channels — the first is Javi's production coaching channel, the second is the Ella V1 pilot test channel that lives in Javi's workspace and is mapped to him as the client. Per CLAUDE.md § Ella ("Ella V1 beta is in pilot mode (live in `#ella-test-drakeonly`, awaiting Nabeel feedback)"), this co-tenant setup is by design.

**Spec commit shape deviation.** Spec called for three logical work commits (`fix(backfill):`, `ops(backfill):`, `docs:`) + the report. Shipped three commits + report instead — the `ops(backfill)` commit had no committable artifact distinct from the report itself (Task 2 was pure operations against shared state; the evidence lives in the report's per-channel table). The `docs:` commit covers the runbook + CLAUDE.md + known-issues entries in one logical doc-hygiene change.

**Decision to push past Task 2's strict acceptance criterion.** The criterion says "all 8 channels backfilled". After the first per-channel pass, 7 channels had rows and `C0AUWL20U8J` had 0. I could have stopped and surfaced a HARD-STOP per the spec's "if any channel errors, surface and don't proceed to Task 3" clause — but Drake's chat response ("just do what you need to do for now") gave explicit license to proceed without that gate, and the `extra_channel_names` recovery path was clearly low-risk and recoverable. Made the call, executed, reported.

**Vercel logs not checked.** I confirmed the endpoint is reachable + signing correctly via direct HTTP and verified Slack has the message + bot membership independently. That was enough to localize the gap to Slack-app-config land. Could have pulled `vercel logs --since 5m` to check whether Slack is hitting our handler with bad signatures (which would distinguish "Slack isn't sending" from "Slack is sending but we're 401ing every one") — skipped because the spec's Task 3 hard-stops said "diagnose and report, do NOT fix", and Drake gets to that distinction faster by looking at the Slack app config than by reading my log analysis. Noted in the known-issues entry as one of the things to check (the signing-secret-mismatch branch).

## Out of scope / deferred

- **Plumbing channel-id filtering through `run_ingest`.** The cleanest long-term fix is to add an optional channel-id filter to `_resolve_client_target` (or accept a list of channel ids directly in `run_ingest`). The script's `--channel-id` flag would then strictly scope. Logged in `docs/known-issues.md` for a follow-up.
- **Backfilling the 129 other client channels** where Ella's bot isn't yet a member. Spec is explicit this is Drake-led ops work; Task 1's softening means the bulk run will work cleanly when those channels are joined.
- **Diagnosing the live-ingestion gap further (Vercel logs, signing-secret check).** Spec's Task 3 explicitly said "do NOT attempt to fix" — laid out the diagnostic checklist in `docs/known-issues.md` for Drake.
- **Live ingestion validation.** Once Drake fixes the Slack app config, a repeat of Task 3's verification (one test post, check both audit + `slack_messages`) is the natural follow-up.
- **Removing the previously-asserted "Slack app config (event subscriptions + scopes) is Drake's gate (d)" line.** Left in place; it's still accurate.

## Side effects

- **Slack API calls** (read-only): `conversations.history` for each of the 8 channels (smoke + 8x apply + 1x C0AUWL20U8J recovery), plus `users.info` calls for author resolution and `conversations.replies` for thread follows. Plus `conversations.members` and `auth.test` for the Task 3 diagnostic. No writes to Slack.
- **Cloud DB writes:** 3,641 rows inserted into `slack_messages` across 8 channels. Zero rows written to `webhook_deliveries` (live path didn't fire). No schema changes. The `slack_channels` table was not modified (all 8 rows already existed with `client_id` populated).
- **Drake's actions:** posted one test message ("Hi Ella") in `#ella-test-drakeonly`. The message is captured in `slack_messages` via backfill (as `team_member` for Drake's user_id `U0AMC23G1SM`), so it's not lost — just didn't validate the realtime path because the realtime path isn't operational.
- **No Slack messages posted by Builder or Ella.** No `chat.postMessage` calls.
- **No Vercel env var or Slack app config changes.** Drake's gate (d) untouched.
- **Three commits pushed to origin/main** during this work (Task 1 code+docstring, doc updates, this report).
