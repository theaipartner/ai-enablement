# Docs sync — Batch 1 done, known-issues cleanup

**Slug:** docs-sync-batch-1-done
**Status:** in-flight

## Context

Ella V2 Batch 1 operational rollout (slug `ella-v2-batch-1-finish-rollout`, shipped 2026-05-10) finished with two pieces of state Builder's report captured accurately at the time but which are now stale:

1. Live ingestion was reported as **NOT operational** because Slack wasn't delivering events to our handler. Builder correctly logged this in `docs/known-issues.md` and surfaced it as a Drake-gate-(d) issue (Slack app config). The root cause turned out to be a missing `message.groups` event subscription — client channels are private (🔒), and `message.channels` alone doesn't fire for private channels. Drake added `message.groups`, reinstalled the app, and verified end-to-end on 2026-05-10. Live ingestion is now operational.
2. A separate ops issue: Vercel auto-deploys silently failed across the last few pushes. Drake recovered via manual Redeploy. Not blocking; worth logging.

This spec is doc-only — no code changes. Builder's job is to make a focused set of surgical edits to CLAUDE.md, `docs/known-issues.md`, and the Batch 1 docs to reflect the now-correct state.

**Why this is a spec rather than Director doing it directly:** the GitHub MCP requires Director to rewrite full files for each edit, which is slow and high-token-cost on a 70KB CLAUDE.md. Builder uses `str_replace` for targeted edits which is much cheaper. Drake has a fix for the MCP limitation queued but not urgent.

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. What CLAUDE.md § Live System State currently says about Ella V2 Batch 1 — specifically the 2026-05-10 sentence that mentions "live ingestion not yet operational, awaiting Drake's Slack-app-config check."
2. What `docs/known-issues.md` currently lists in the **resolved-this-session** vs **unresolved** sections — particularly the two entries Builder added during `ella-v2-batch-1-finish-rollout` execution (live-ingestion-not-operational, and the backfill `--channel-id` design bug).
3. What `docs/runbooks/slack_message_ingest.md` currently says about live ingestion being live (it currently reflects the post-V1-ship state, not the actual post-rollout-fix state — verify before editing).
4. Whether the failed Vercel deploys from earlier today are documented anywhere in the repo (check `docs/known-issues.md` for any existing Vercel-cache-related entry; CLAUDE.md § Operational patterns has a long 2026-05-08 recovery procedure for cache contamination that may or may not be the same issue).
5. The current shipped/superseded state of `docs/specs/ella-v2-batch-1-finish-rollout.md` — should still be `in-flight` because EOD batch deletion hasn't run yet per the updated CLAUDE.md convention.

## What success looks like

After Builder's commits land, the following are true:

### CLAUDE.md § Live System State

The Ella V2 Batch 1 entry (the 2026-05-09 bullet about Slack ingestion going live) gets an appended sentence reflecting the 2026-05-10 rollout completion. Suggested addition (Builder can tighten wording if it reads better):

> Backfilled to cloud on 2026-05-10: 3,641 rows across 8 channels (Musa Elmaghrabi, Javi Pena production + #ella-test-drakeonly, Trevor Heck, Dhamen Hothi, Jenny Burnett, Art Nuno, Fernando G). Live ingestion verified operational on 2026-05-10 after `message.groups` event subscription was added to the Slack app config (private channels are 🔒, `message.channels` alone doesn't fire for them; both subscriptions are now active). The 129 remaining client channels are pending Drake-led ops work to invite Ella's bot — once added, both backfill and realtime ingestion light up automatically with no further code changes (backfill script's `bot_not_in_channel` hard-stop was softened in this same rollout pass, so a single bulk `--apply` will work cleanly across all channels).

If Builder's read of § Live System State suggests the existing sentence about "live ingestion not yet operational" needs replacing rather than appending-to, do the replace. Use judgment.

### docs/known-issues.md

**Mark resolved** (move from active section to a resolved/historical section, OR strike through with a "RESOLVED 2026-05-10" note — match whichever pattern the file already uses):

- The "Ella V2 Batch 1 realtime live ingestion not operational" entry Builder added during `ella-v2-batch-1-finish-rollout`. Resolution note: "Resolved 2026-05-10 — root cause was missing `message.groups` event subscription. Private (🔒) client channels require `message.groups`; `message.channels` alone fires only for public channels. Drake added the subscription, reinstalled the Slack app, retested end-to-end with a fresh post in `#ella-test-drakeonly`; `webhook_deliveries` and `slack_messages` rows landed within seconds. Both `channels:history` and `groups:history` scopes are now active on the bot token."

**Keep as-is** (still active, not resolved):

- The backfill `--channel-id` design bug Builder logged ("--channel-id flag doesn't strictly scope when a client owns multiple channels"). Resolution is logged in that entry; this spec doesn't fix it.

**Add new entry** for the Vercel deploy gap:

- **Title:** Vercel auto-deploys silently failed on recent pushes to main (intermittent).
- **Symptom:** Pushes to `main` did not trigger successful Vercel deploys for some unknown number of recent commits. Manual "Redeploy" via the Vercel dashboard fixed it.
- **Recovery:** Open Vercel → Deployments → click Redeploy on the latest commit. Drake observed this worked without needing the "Use existing Build Cache" toggle change from the 2026-05-08 cache-contamination procedure — different failure mode, same recovery surface.
- **Why not urgent:** redeploy works, and the failure is visible in the Vercel dashboard (red status on the auto-deploy). Drake's gate-(c) post-deploy verification catches this on the same day.
- **Diagnostic open question:** what's actually failing in the auto-deploy step — build error, GitHub-integration trigger missing the push, or something else? Worth checking the failed deploy logs next time it happens to capture the actual failure signature before redeploy clears it.
- **Logged:** 2026-05-10.

If the file already has a Vercel-cache-contamination entry from 2026-05-08, Builder should reference it from the new entry ("see also: §<wherever> for the related cache-contamination signature") without duplicating its content.

### docs/runbooks/slack_message_ingest.md

Two surgical edits:

1. Anywhere the runbook describes live ingestion as "shipped" or "live" without explicitly noting the `message.groups` requirement, add a sentence under the relevant section. Suggested placement: the "Slack app scopes" or "Event subscriptions to enable" section. Wording:

> Both `message.channels` AND `message.groups` event subscriptions are required. Client channels are typically private (🔒), and `message.channels` only fires for public (`#`) channels; `message.groups` is what fires for private channels. Until both are subscribed, realtime ingestion appears completely broken for private channels — events simply never reach the handler. Bot scopes `channels:history` AND `groups:history` are both required to back these subscriptions.

2. If the runbook's "Symptom: a message I sent isn't in `slack_messages`" debugging section doesn't already mention this failure mode, add it as a new bullet point. Suggested addition (place it as the first bullet, since this is the most likely cause):

> **First check.** If you're testing in a private channel (🔒) and no row appears in `webhook_deliveries`: verify both `message.channels` AND `message.groups` event subscriptions exist on the Slack app, and that `channels:history` AND `groups:history` scopes are granted on the bot token. Missing `message.groups` is a silent failure mode — Slack accepts the subscription save without complaint, the URL stays verified, but no events fire for private channels.

### docs/specs/ella-v2-batch-1-finish-rollout.md

Update the spec's Status header from `in-flight` to `shipped`. Builder does NOT delete the spec file — per the updated CLAUDE.md convention, shipped specs and reports stay in place until Drake batches them at EOD.

If the spec doesn't have a front-matter `Status:` line at all (it was written before the convention was fully codified; Builder verifies), no action — leave it.

## Hard stops

- **No code changes.** This is doc-only. If Builder finds itself reaching for `scripts/` or `api/` or `ingestion/`, stop and re-read the spec.
- **No changes to `docs/specs/<other-slug>.md` files** beyond the status update on this rollout's spec. The two pre-convention specs in the directory have already been flagged as a "won't backfill front-matter retroactively" decision per Director's prior call.
- **No new known-issues entries beyond the three documented above** (resolve one, keep one, add one). If Builder notices something during the read-through that feels like it should be a known-issue, flag in the report's Surprises section rather than silently adding it.
- **No CLAUDE.md restructuring.** Append/replace within existing sections only.

## Mandatory doc updates (this section IS the doc updates)

Already enumerated above. Builder writes the report explicitly confirming each one was made, or explaining why (if any wasn't applicable).

## What could go wrong

Think this through yourself:

- The existing CLAUDE.md § Live System State sentence about "live ingestion not yet operational" might be phrased differently from what this spec quoted. Builder uses `str_replace` against the actual file content, not the spec's paraphrase.
- The `docs/known-issues.md` file might use a section header pattern Builder hasn't seen before (resolved-vs-active separation). Read it before editing; match its existing convention rather than inventing a new one.
- The runbook might already have the message.groups note in some form (added during a prior edit Director isn't tracking). If so, Builder leaves it and notes "already present" in the report.
- The spec file's Status line might already be missing or formatted differently. If Builder can't make the status update cleanly (no clear `Status:` line to replace), skip and note in the report — Director can handle that one manually.

## Commit + report

One logical commit per file edited, per CLAUDE.md § Commits. Suggested commits:
- `docs: mark Ella V2 Batch 1 live ingestion operational in CLAUDE.md`
- `docs: resolve live-ingestion known-issue, add Vercel auto-deploy entry`
- `docs: note message.groups requirement in slack_message_ingest runbook`
- `docs: mark ella-v2-batch-1-finish-rollout spec as shipped`

If splitting feels forced, Builder can bundle into 2-3 commits — the principle is "one logical change per commit," not a rigid four-commit shape. Use judgment.

Report at `docs/reports/docs-sync-batch-1-done.md` per the spec/report convention. Push after all doc commits land. Final commit message: `docs: add report for docs-sync-batch-1-done`.
