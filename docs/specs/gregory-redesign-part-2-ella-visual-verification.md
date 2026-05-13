# Gregory Redesign Part 2 — Ella visual verification + finish what didn't land
**Slug:** gregory-redesign-part-2-ella-visual-verification
**Status:** in-flight

## Context

Four Ella specs have shipped on this branch. The deploy preview after the most recent one still has visible issues that Builder reported as fixed. Drake's reaction on 2026-05-13 verbatim: "So no tables, no emojis, no surrounding messages, Im not sure it did anything."

The root cause is procedural, not technical. Builder has been verifying its work by reading code paths, tracing predicates, confirming types compile, and inspecting query branches — but never by actually loading the rendered page. The topology had Drake's deploy-preview smoke as the verification surface (gate (c)). That works when the work makes it to the screen; it fails loudly when it doesn't, because the failure isn't discovered until after Drake walks the preview, by which point Builder has already moved on and Drake has spent more cycles than the fix deserved.

This spec changes that for the Ella visual fixes specifically. **Builder visually verifies its own work this time** by loading the deployed Vercel preview, screenshotting the affected pages, and confirming the rendered output matches the spec before flipping `Status: shipped`. The mechanism for "loading the deployed Vercel preview" is part of Builder's task — figure out the auth path, screenshot, iterate.

If this works, a follow-up spec lifts visual verification into CLAUDE.md as a permanent norm. If it doesn't work (auth is too painful, screenshots aren't useful, etc.), Drake and Director will revisit the approach. **This spec is the experiment.**

**Stacks on the existing `gregory-redesign-part-1-foundations` branch.** Same PR.

## Reference reads (in this order)

1. `docs/specs/gregory-redesign-part-2-ella-list-polish.md` and its report — the spec that introduced the table chrome strip + row borders.
2. `docs/specs/gregory-redesign-part-2-ella-detail-and-cleanup.md` and its report — the spec that introduced the surrounding-messages-always-5 logic, the section reorder, the Haiku-always section, and the emoji-rendering research task.
3. Both reports' "Surprises and judgment calls" sections — flag anything where Builder's stated outcome doesn't match the deployed-preview reality.
4. `app/(authenticated)/ella/runs/page.tsx` + `runs-table.tsx` + `summary-band.tsx` + `filter-bar.tsx` — list-page surface.
5. `app/(authenticated)/ella/runs/[id]/page.tsx` — detail-page surface.
6. `app/globals.css` — search for `gregory-editorial` block; the `tbody tr` border rule lives here.
7. `lib/db/ella-runs.ts` — surrounding-messages query path, emoji-bearing data sources.
8. `lib/slack/render-mentions.ts` — mention rendering helper from the prior spec.

**Acclimatization checkpoint:** before writing any code, confirm in 4–5 bullets in your first commit message: (a) the audit list — for each of the three known visual issues (row dividers, emojis, surrounding messages) plus any others surfaced from cross-referencing the prior two reports, what was supposed to land per spec and what's actually visible on the deployed preview, (b) your plan for visually verifying the preview (Playwright? puppeteer? the auth path you'll use), (c) the file map you intend to touch, (d) which prior-report-claimed-as-shipped items you found unshipped or partially shipped, (e) any unexpected drift. If (e) is non-trivial, surface to Drake before continuing past the first commit.

## Decisions locked in by Director

From Drake/Director conversation 2026-05-13. Build to these.

1. **Builder visually verifies its work on this spec.** Before flipping status to shipped, Builder loads the Vercel preview URL (auto-deployed from PR #?), navigates to `/ella/runs` and `/ella/runs/[id]` for at least 2 representative runs (one reactive, one passive substantive), screenshots, inspects. Each of the three known visual issues (§ A, § B, § C below) has a screenshot in the report demonstrating the fix.

2. **Auth path for the preview is Builder's call.** Three real options:
   - **(i)** Pull a long-lived session cookie from Drake's authenticated browser session and store it in `.env.local`. Builder reads it and injects via Playwright's `context.addCookies()`. Persists across sessions until the cookie expires.
   - **(ii)** Authenticate fresh per session using Supabase Auth credentials stored in `.env.local`. Builder runs the login flow programmatically.
   - **(iii)** Run the Next.js dev server locally (`npm run dev`) with a fresh Supabase connection from `.env.local`. Auth still applies but localhost is sometimes easier.
   
   **Director's lean: (i).** Cheapest path. Drake exports a cookie once; Builder uses it across multiple iterations of this and future visual-verification specs. If (i) is blocked (cookie format issues, refresh-token complexity), fall back to (iii) — local dev is the next most reliable. **Don't bypass auth via a middleware flag.** That's a security smell even in dev.

3. **Audit the prior two specs' "claimed shipped" items.** Before writing any new code, Builder cross-references both prior reports against the deployed preview. For each item the prior reports listed under "What I did" or "Verification," confirm it's actually visible. If something was claimed as shipped but isn't actually working, list it in this spec's audit and fix it. Drake suspects multiple items are in this category beyond the three he named.

4. **Three known issues to fix at minimum:**
   - **§ A. Row dividers.** Should be clearly visible between rows on the list page. Currently still too subtle per Drake's 2026-05-13 walk.
   - **§ B. Emoji rendering.** Shortcodes like `:right-facing_fist:` should render as 🤜 on both the list output column and every text field on the detail page (triggering message, Ella's response, surrounding messages, Haiku reasoning). The prior spec's research concluded "Slack sends unicode" — re-verify that claim by inspecting actual `slack_messages.text` values from production for messages that contain emojis. If Slack sends shortcodes (not unicode), the prior spec's premise was wrong and shortcodes need to be transformed at the render layer.
   - **§ C. Surrounding messages.** Always renders 5 messages including the trigger, for every run regardless of reactive/passive status. Currently the section shows just the trigger for some runs.

5. **Any additional issues surfaced by the audit (Decision 3) get fixed in this spec** as long as they're visual / list / detail bugs in the Ella surface. Out-of-scope: anything that requires touching `agents/ella/` Python, the data-layer anomaly code, or a schema migration. If a non-visual issue surfaces, log it to `docs/known-issues.md` with a note and defer.

## What success looks like

### A. Row dividers visibly readable

Investigate the current state on the deployed preview. The prior spec changed `app/globals.css` `tbody tr` border from `--color-geg-border` (0.08 opacity) to `--color-geg-border-strong` (0.14 opacity). Drake reports the dividers still aren't readable. Either:

- The opacity bump landed but isn't enough — try a stronger border (e.g. a non-opacity-modulated token, or a higher opacity, or `1px solid` with a different color value entirely). Builder's call within existing tokens; if no token works, surface for a new one.
- The CSS rule didn't actually apply (specificity issue, theme scope wrong, build cache contamination). Inspect via the Playwright session's DOM + computed styles.

Fix path depends on the root cause. Both root-cause-investigation and fix happen in the same commit if the answer is obvious; surface to Drake if the fix requires a token decision.

**Acceptance:** screenshot of `/ella/runs` showing rows visually separated at a glance. Drake doesn't have to squint.

### B. Emoji rendering on list + detail

The prior spec's research concluded Slack delivers unicode natively. Drake's walk says shortcodes appear on the detail page. Reconcile:

1. **Re-verify the data shape.** Query production `slack_messages` for at least 3 rows containing emoji-likely text (e.g. text containing `:` characters; look in Ella's outgoing messages from the last 30 days). Are the emojis stored as unicode (🤜) or as shortcodes (`:right-facing_fist:`) in `slack_messages.text`?
2. **If unicode:** the bug is somewhere in the render path on the detail page. Each text field (triggering message, Ella's response, surrounding messages, Haiku reasoning) reads from a specific data source — find which source ships shortcodes when others ship unicode. The fix is per-field-data-path.
3. **If shortcodes:** the prior spec's premise was wrong. A render-time transform is needed. Options for the transform:
   - **(a)** `node-emoji` library — handles standard shortcodes, ~50KB. New dependency, CLAUDE.md § Never Do exception territory but justified for this use case.
   - **(b)** A small inline shortcode-to-unicode lookup table covering the top ~30 emojis seen in production data. Builder generates the table by querying `slack_messages` for all distinct shortcode patterns in the last 60 days.
   - **(c)** Custom emoji-shortcode parser using the public emoji JSON spec.
   - **Director's lean: (a).** Trust an established library over rolling our own. Builder asks Drake explicitly in the report's Surprises section before adding the dependency (CLAUDE.md requires explicit ask).

**Acceptance:** screenshot of `/ella/runs/[id]` for a run whose response contains emojis, showing emojis rendered correctly. Apply consistently — if the list page renders emojis but the detail doesn't, that's not done.

### C. Surrounding messages always 5

The prior spec implemented `centerWindowAroundTrigger` + `fetchLastNChannelMessages` + a trigger-inclusion guarantee. Drake reports the section still shows only the trigger for some runs. Investigate:

1. **For a run where Drake sees only the trigger:** trace the data flow. `run.thread_messages` is the array consumed by the detail-page section. What does `getEllaRunDetail` return for that run?
2. **Check whether `thread_ts` is being read correctly** — if `thread_ts` is null on a passive run, the code should fall through to `fetchLastNChannelMessages`. Verify the predicate.
3. **Check whether the channel's `slack_messages` actually have enough messages** to render 5 — if a channel has only 1 message, rendering 1 is correct. If a channel has 50 messages and the section shows 1, the query is broken.
4. **Check whether the trigger-inclusion guarantee is firing** — if the trigger isn't in `slack_messages`, the synthesized row should be appended. Confirm.

Fix depends on which step fails. Likely candidates: the thread_ts read is wrong, or the fallback query has a filter that's excluding messages, or the data is correct but the render is broken.

**Acceptance:** screenshot of a passive-monitor substantive run's detail page showing the surrounding messages section with the trigger + at least some preceding messages (5 total if the channel has them).

### D. Audit-surfaced fixes

For each item Builder's audit (Decision 3) discovers, fix in the same spec if it's a visual / list / detail Ella bug. Document each fix in the report under its own subsection. The audit is the load-bearing step — without it, this spec is just "fix three things Drake noticed" and the next walk will surface more.

Specifically check the prior reports' claims about:

- Output column rendering Ella's response (not `queued (...)` placeholders).
- Mentions rendering as `@First Last` everywhere, including detail page text fields.
- Cost-rollup math on substantive passive runs (Haiku decision cost + Sonnet response cost summed in HeaderBand).
- Haiku-always section rendering for reactive @-mention runs with synthetic content.
- Section order on the detail page matches the spec.
- The placeholder `queued (` skip being a no-op now that the trigger_type filter hides those rows.
- HeaderBand actions slot reading post-filter response-scope total.

Each of these was claimed as shipped. Spot-check each on the preview.

### E. Visual verification mechanism documented in the report

The report includes:

- A short description of the verification setup (which tool, which auth path).
- Screenshots of each fix (one per fixed surface).
- A brief note on what Drake would need to do to reproduce the verification himself.

This isn't extra; it's the deliverable. The point of this spec is the *practice*, not just the fixes.

## Hard stops

1. **Before the first code change, Builder completes the audit (Decision 3) and surfaces it.** The first commit body contains the audit (acclimatization point a). If the audit reveals more than 5 unshipped items from prior specs, stop and surface — the scope is bigger than this spec assumed and Drake decides what makes the cut.

2. **If the auth path (Decision 2) is harder than expected** — e.g. (i) blocked on cookie refresh, (iii) blocked on local Supabase config — stop and surface. The point of this spec is the visual verification practice; if the practice is unworkable, Drake needs to know rather than Builder spending a session fighting Playwright.

3. **If emoji rendering requires `node-emoji` (§ B option (a))**, stop and surface before installing. CLAUDE.md § Never Do requires explicit ask. Drake says yes/no in the report's Surprises section before the install.

4. **If the audit surfaces issues that aren't visual / list / detail Ella bugs** (e.g. data-layer correctness issues, Python agent issues, schema issues), do NOT fix them in this spec. Log to `docs/known-issues.md` with a note describing what was found, defer to a future spec.

## Think this through yourself — what could go wrong

- **Playwright in Builder's sandbox.** Builder's environment includes a Linux container with Node + npm. Playwright + Chromium download is large (~150MB) but standard. If sandbox networking blocks the Chromium download, the visual-verification mechanism falls back to manual screenshot description, which is much weaker. **Mitigation:** if the install path fails, surface to Drake.

- **The Vercel preview URL.** PR #? auto-deploys to a URL like `https://ai-enablement-git-{branch}.vercel.app` or similar. Builder needs to find the exact URL — check the PR's deployment status via the GitHub MCP, or have Drake paste the URL into chat if the MCP doesn't surface it.

- **Auth cookie expiry.** Drake's cookie may expire mid-session. If a Playwright request returns 401 / 302-to-login, Builder asks Drake for a fresh cookie. If this happens too often, fall back to option (ii) or (iii).

- **Screenshots may not surface the actual problem.** A row-divider opacity issue is visible in a screenshot. An "emoji is missing" issue is visible. But a "row spacing feels wrong" issue might not jump off a screenshot — that's a felt-quality issue. **Mitigation:** Builder describes what it sees alongside the screenshot, not just "here's the image." If felt-quality issues come up, surface in Surprises with Builder's own read of the screenshot.

- **The audit might reveal that several prior spec items genuinely weren't shipped.** If Drake's intuition is right ("Im not sure it did anything"), the audit list could be long. **Mitigation:** the hard stop at 5+ items prevents Builder from trying to fix everything at once. Drake triages.

- **The emoji shortcode question is unresolved from the prior spec.** Builder previously concluded "Slack sends unicode" via grep + ingest-code inspection. Drake's walk says otherwise. The data-shape re-verification (§ B step 1) is the load-bearing step — if it confirms unicode, the bug is downstream of ingest; if it confirms shortcodes, the prior research was wrong. **Mitigation:** the actual SQL query against production `slack_messages` is the source of truth. Run it.

- **The verification practice itself may not transfer to other surfaces.** Ella audit pages are public-data-light (no client info beyond names). `/clients/[id]` carries PII. Visual verification of pages with sensitive data needs Drake's explicit comfort. **Mitigation:** if this spec works, the CLAUDE.md follow-up captures the practice with appropriate guardrails. Not Builder's concern in this spec; Drake's call later.

## Mandatory doc-update list

- `docs/known-issues.md` — possibly. If the audit (Decision 3) surfaces non-visual-Ella issues that get deferred per hard stop #4, log them here with one line each.
- `docs/agents/ella/ella.md` — possibly. If the emoji-rendering research (§ B step 1) reveals a data-shape detail worth documenting (e.g. "Slack sends shortcodes for custom emojis but unicode for standard ones"), add a one-paragraph note.
- `docs/gregory-conventions.md` — does not need updating. The visual verification practice belongs in CLAUDE.md (follow-up spec), not the per-surface conventions.
- `CLAUDE.md` — explicitly out of scope for this spec. Visual verification as a permanent norm is a follow-up spec if this experiment succeeds.
- `docs/state.md` — does not need updating.
- `docs/future-ideas.md` — possibly. If the follow-up CLAUDE.md spec is worth tracking explicitly, add a one-line entry.

## Out of scope for this spec (explicit)

- Lifting visual verification into CLAUDE.md as a permanent norm — separate spec if this experiment succeeds.
- Per-page redesigns of `/clients`, `/clients/[id]`, `/calls`, `/calls/[id]` — Part 2 specs each.
- Anything requiring Python agent changes — `agents/ella/` stays untouched.
- Schema migrations — none.
- Tests — deferred to `gregory-ts-test-infra`.
- The `/ella` Nabeel-facing dashboard — deferred.
