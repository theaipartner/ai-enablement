# Report: Decisions-flow ritual + ADR backfill (decision capture into docs/decisions/)
**Slug:** decisions-flow-and-adr-backfill
**Spec:** docs/specs/decisions-flow-and-adr-backfill.md

## Files touched

Created:

- `docs/specs/decisions-flow-and-adr-backfill.md` — the spec.
- `docs/reports/decisions-flow-and-adr-backfill.md` — this report.
- `docs/decisions/0004-ella-at-mention-passive-split.md` — new ADR (Part 2, backfill #1).
- `docs/decisions/0005-cost-hub-archive-semantics.md` — new ADR (Part 2, backfill #2).

Modified:

- `CLAUDE.md` — three surgical str_replace edits:
  - Line 58 (§ Working Norms › Communication preferences) — rewrote the "Capture decisions in writing as you make them" bullet to distinguish lightweight tactical decisions (ride in spec body / chat memory) from architectural-or-process decisions (become ADRs in `docs/decisions/`). Calls out the structural reason (specs get deleted at EOD → spec body is NOT a durable record) and names the two ADR-producing mechanisms: per-spec (A) and EOD decisions-sweep (B).
  - Line 183 (§ Director / Builder System › Spec and report convention › Cleanup cadence) — appended a clause clarifying that durable decision rationale lives in ADRs, not in spec bodies; any decision worth remembering must be ADR'd before cleanup runs; decisions sweep is the backstop.
  - Lines 273-279 (new subsection at the end of § Director / Builder System) — added `### Session close-out (EOD)` as a short three-pointer list: (a) spec/report cleanup (cross-refs Cleanup cadence), (b) living-doc updates (cross-refs Update Policy), (c) decisions sweep (the new ritual). Deliberately a pointer list — references existing sections instead of restating them.
- `docs/specs/decisions-flow-and-adr-backfill.md` — `Status:` flipped from `in-flight` to `shipped` as part of the final commit.

## What I did, in plain English

The session has been throwing off real architectural decisions but only producing three ADRs total because under the specs-only topology, decisions ride in spec bodies that get deleted at EOD — the durable "why" disappears. The fix is two-part. First, CLAUDE.md now distinguishes lightweight decisions (spec body / chat memory is fine) from architectural-or-process decisions (must become ADRs), and names two complementary mechanisms for producing ADRs: per-spec (Director adds the ADR write to the spec's doc-updates list when the spec embodies a decision) and end-of-session backstop (a "decisions sweep" tiny spec at session close that catches decisions which didn't ride a feature spec). A new `### Session close-out (EOD)` subsection makes the three EOD duties visible in one place: shipped-spec cleanup, living-doc updates, decisions sweep. Second, the two load-bearing decisions made during this session that hadn't been ADR'd got backfilled: ADR 0004 for the Ella @-mention / passive-monitoring split (the synchronous @-handler with structured-JSON output, the observation-only passive path, the four escalation categories with no navigation rule, the status-honesty fix), and ADR 0005 for the cost-hub archive semantics (active-in-month total, Cancel-vs-Remove split, cancelled-but-visible badge, extras-Remove-only, single-source-list structural guard). Both ADRs match the 0003 template (Date / Status / Decision makers / Context / Decision / Consequences [Positive / Negative-accepted] / Known deviations / Implementation pointers / Review).

## Verification

- **CLAUDE.md re-read end-to-end across the edited sections** (Communication preferences, Cleanup cadence, the new EOD subsection) — no contradiction with the existing specs-only / Director-doesn't-edit-docs rules. The new text explicitly says "Director writes a spec that embodies an architectural decision, the ADR write rides in that spec's mandatory-doc-updates list and Builder lands it during execution" and "any decision...gets one via a tiny dedicated spec Builder executes" — both phrasings respect the constraint that Director writes specs, not docs. Verified no path through the new wording would tell Director to do something it structurally cannot.
- **str_replace was used for every CLAUDE.md edit** — no full-file regenerations. The diff confirms only the three targeted blocks changed; no unrelated drift in the rest of the file.
- **Both ADRs match the 0003 template.** Side-by-side check of section ordering and field shape: `# ADR NNNN: Title`, Date / Status / Decision makers, Context, Decision (with named sub-decisions where applicable), Consequences (Positive / Negative-accepted), Known deviations + status, Implementation pointers, Review. Both backfill ADRs follow.
- **Next-ADR-number ordering confirmed**: `ls docs/decisions/` showed only 0001 / 0002 / 0003 pre-edit, so 0004 and 0005 are the correct next slots.
- **No code changes** (docs-only spec). No tests run because nothing to test — `tsc` / `lint` would also be unaffected. Skipped both per the docs-only nature of the change.

## Surprises and judgment calls

**ADR 0003's `/ella/runs` cross-reference was already fixed in the prior spec.** The spec author flagged that ADR 0003's "Implementation pointers › Consumers today" line might be stale post `remove-ella-runs-page`. Checking it: the prior spec (executed earlier this session) updated that line in place — it now reads `**Consumers today:** lib/db/cost-hub.ts. (lib/db/ella-runs.ts:getEllaSummaryStats was also a consumer until the /ella/runs audit page was removed on 2026-05-24 — spec remove-ella-runs-page deleted the data layer with the route.)`. No further action needed. ADR 0003's "Origin" line still references the cost-hub-vs-`/ella/runs` diagnostic — that's historical origin context (the diagnostic happened, the ADR came from it) and is correct to leave as-is.

**Placement of the new EOD subsection.** I put it at the end of § Director / Builder System, after `### Gate trajectory`. The spec suggested "in § Director/Builder System" but didn't fix the exact home. After-Gate-trajectory keeps the topology-related subsections (Roles / Spec convention / Builder / Director / Drake's gates / Gate trajectory) together at the top of the section and lets the procedural EOD capstone live at the bottom. The alternative — placing it right after `### Spec and report convention` (since cleanup-cadence lives there) — would have visually broken up the gate-related subsections. Call this out if you'd have preferred the alternative; one str_replace move would shift it.

**ADR 0004 is long.** The @-mention / passive split is genuinely the biggest decision of the recent stretch — five-spec diagnostic chain, two deleted modules, the structural-fix-over-prompt-iteration principle in action, four escalation categories, status-honesty fix, identity-routing sub-decision, recent-context plumbing change. I leaned toward thorough over terse because a cold reader six months from now needs to understand both *what* was decided and *why the prior shape failed*, and the prior-shape part is the load-bearing context. If it reads bloated to Drake, the easy trim is the "Architectural-pattern reference" subsection (it can collapse to one sentence pointing at the existing CLAUDE.md operational pattern instead of restating its prescription).

**Decisions I considered ADR-worthy but did NOT write** (flagged for Director per the spec's instruction):

- **`docs/working/` frozen-artifact convention.** During `remove-ella-runs-page`, I made a process call to leave `docs/working/gregory-redesign-compiled.md` untouched even though it referenced the deleted `/ella/runs` page — on the principle that working-discussion docs are records of what happened during a design phase, not living docs to be retro-edited. That's actually a small *process* decision (when do we edit docs/working/ vs leave them?). It hasn't recurred enough to feel ADR-worthy yet (n=1), but if Director sees more cases of "do we treat docs/working/ as living or frozen," it'd be a candidate for ADR 0006. Flagging rather than writing it.
- **Director-writes-specs-only mechanical rationale (the GitHub-MCP full-file-overwrite constraint).** This is already captured in CLAUDE.md § Director / Builder System › Director behavior under "Why specs-only — the MCP-edit constraint." It's effectively an in-CLAUDE-md ADR. Could be promoted to a real ADR 0006 if Drake wants it more findable, but the current location works.
- **The two-token Slack identity strategy (M1.4 user-first, bot-fallback).** Captured as a sub-decision inside ADR 0004 (the `post_message_as_user_first` line + the operational-rollback note). Lives there appropriately; doesn't need its own ADR unless the routing strategy expands to a third surface.
- **The push-without-Director-review topology shift.** Already captured in CLAUDE.md § Director / Builder System › Director behavior under "The push-without-review tradeoff." It's effectively an in-CLAUDE-md ADR (Director-out-of-loop on push; remaining quality gates enumerated; spec quality becomes load-bearing). Could be promoted to a real ADR if Drake wants it findable under `docs/decisions/`, but the location is appropriate today.

If any of these are wrong calls — particularly the `docs/working/` one — Director can fold them into a future tiny spec.

**The spec's "lightweight vs architectural" distinction is fuzzy by design.** The wording in the new CLAUDE.md bullet says "we chose X over Y because Z" calls that future sessions will need to understand → ADR. The judgment is Director's per spec; Builder writes whatever's specced. No taxonomy I could have written would have produced a sharp boundary. Accepted as a deliberate calibration call.

## Out of scope / deferred

- **Backfilling ADRs for older decisions** (pre-this-session): not scoped here. The spec was explicit — backfill ONLY the load-bearing recent ones (0004 + 0005). If Director wants to walk back through earlier work and ADR what's still load-bearing (V2-batching architecture, the worktree topology, the Builder-pushes-own-code transition, etc.), that's a separate spec.
- **Auto-enforcement of the EOD decisions sweep.** Today it's a Director-discipline thing: Director scopes the sweep into a spec at session close if any decisions are outstanding. No tooling forces it. If specs keep getting deleted without sweeps happening, a `.claude/commands/eod.md` slash-command that runs an inventory ("decisions made this session that aren't in `docs/decisions/`") could be a future spec. Out of scope here.
- **ADR template doc.** Today the template is implicit (read 0003 + match shape). Could become explicit (a `docs/decisions/0000-template.md` or a short template paragraph in CLAUDE.md). Not built; defer until friction shows up.
- **Cross-linking from the source spec to the resulting ADR** — every shipped spec that produced an ADR could note "ADR 0NNN ships with this work" in its body. Today the linkage lives in the ADR's "Implementation pointers › Source spec" line only. Sufficient for now; the inverse link is recoverable from git.

## Side effects

- **Zero code changes.** Pure docs work — three CLAUDE.md str_replace edits, two new files in `docs/decisions/`, one new spec, one new report.
- **Zero production calls.** No Slack posts, no DMs, no DB writes, no API hits.
- **Zero env-var changes.** Drake's gate (d) untouched.
- **No live-system effects.** A future Director session that loads CLAUDE.md cold will see the new decision-capture ritual; a future Builder asked to look up "why we chose the @-mention split" will find ADR 0004 instead of git-spelunking through deleted spec bodies. That's the intended-and-only visible change.
