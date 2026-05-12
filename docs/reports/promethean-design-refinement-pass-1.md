# Report: Promethean design refinement — pass 1 (broadsheet)
**Bundle:** `lithium/design_handoff_promethean_overview_broadsheet/` (PROMPT.md + README.md)

## Files modified

Exactly three files, all in the scope you explicitly allowed:

1. `app/globals.css` — additions inside the existing `[data-theme="promethean"]` block only. Six new utility classes added: `.prom-display`, `.prom-section-title`, `.prom-deck`, `.prom-numeric-serif`, `.prom-section-slug`, `.prom-strip` + `.prom-strip-col`. **Zero new color or spacing tokens.** The existing `@theme inline` block (the source-of-truth palette) is unchanged. Everything outside `[data-theme="promethean"]` is unchanged.
2. `components/promethean/primitives.tsx` — `PromPageHeader`, `PromSection`, `LeverageCard` enhanced (additive props only, existing call sites stay valid). Four new exports: `SectionSlug`, `StripPanel`, `StripCol`, `PromBylineStrip`. No existing primitives removed or renamed.
3. `app/(authenticated)/promethean/page.tsx` — full rewrite to the broadsheet composition. Local helpers (`MoneyStripCol`, `AcquisitionStripCol`, `Sparkline`) live inside this file as before.

## Files NOT touched — scope confirmation

- ✅ Nothing outside `app/(authenticated)/promethean/` or `components/promethean/` (plus the scoped globals.css block).
- ✅ `app/(authenticated)/layout.tsx` — untouched. Still carries the temp auth bypass from `promethean-preview-auth-bypass`.
- ✅ `components/authenticated-shell.tsx` — untouched.
- ✅ `components/promethean/shell.tsx` (sidebar) — untouched.
- ✅ `components/promethean/primitives-extra.tsx` — untouched.
- ✅ All other Promethean sub-pages (`closers/`, `setters/`, `setter-qc/`, `inbox/`, `marketing/`, `deep-dive/`, `pipeline/`, `financials/`, `contacts/`, `triage-inbox/`, `ai-mode/`, `setter-eod/`, `number-health/`, `money-on-table/`, `payment-plans/`, `cohort-retention/`, `pnl/`) — code unchanged. They inherit the enhanced primitives by sharing the same imports.
- ✅ `lib/mock-data.ts` — **unchanged**. No edits to data shapes, no edits to derived-metric helpers, no edits to types. `git diff` against `main` for this file shows only the additions from the original Promethean V0 ship (the seeded mock data); nothing landed in this refinement pass.
- ✅ `lib/promethean-vocab.ts` — untouched.
- ✅ `lib/utils.ts` — untouched.
- ✅ All shadcn / Gregory / Ella code — untouched.
- ✅ `vercel.json`, `next.config.mjs`, `package.json`, `tsconfig.json` — all untouched.
- ✅ The existing color/spacing tokens inside `[data-theme="promethean"]`'s `@theme inline` block — unchanged. Only utility-class declarations were appended.

## Commits on `promethean-shell`

- `800056b` — `promethean: add broadsheet utility classes and enhance primitives`
- `5690d1c` — `promethean: rewrite Overview to broadsheet pattern`
- (the report commit follows)

Both pushed to `origin/promethean-shell`.

## `npm run build` status

**Clean.** Final run produced all 27 routes including 18 under `/promethean`. No TypeScript errors, no ESLint warnings, no React warnings. Page sizes and First Load JS unchanged from pre-refinement (188–196 B / 87.5–96.2 kB) — purely visual refinement, no bundle bloat.

## What I did, in plain English

The bundle asked for a hi-fi visual-polish refinement of the Overview surface toward a "broadsheet" feel — bigger serif type, hairline rules instead of rounded cards, Roman-numeral section slugs, generous vertical rhythm. The change is purely visual; every data call, every prop signature, every other Promethean surface keeps working.

Three logical layers shipped:

- **CSS layer** — six new utility classes inside the existing theme block. `.prom-display` for the 86px headline, `.prom-section-title` for the 38px section H2 scale, `.prom-deck` for the italic editorial sub-copy, `.prom-numeric-serif` for tabular Instrument-Serif numerics, `.prom-section-slug` for the small-caps left-margin label with its 2px top rule, and `.prom-strip` / `.prom-strip-col` for the bordered horizontal strips with internal column dividers. All compose existing CSS variables; no new color or spacing tokens were declared anywhere.

- **Primitives layer** — `PromPageHeader` gained an optional italic `deck` slot to the right of the title and a hairline rule between the eyebrow row and the H1 row, plus the 86px display H1. `PromSection` switched to a two-column header (180px section slug on the left, title + optional deck on the right) with a fixed 88px section rhythm. `LeverageCard` lost the progress bar (the comparison sentence carries the meaning), gained a 54px serif accent cash delta, a `fromValue → toValue` row in tabular Inter, and an italic curly-quoted coaching pullquote with a dotted top rule. The `current` / `target` props stay optional in the type for back-compat; they're accepted and ignored, so existing call sites on other Promethean pages keep working untouched. Four new helper exports: `SectionSlug`, `StripPanel`, `StripCol`, `PromBylineStrip`.

- **Page layer** — Overview rewritten section by section per the README's spec. The page title is "Every dollar," on line 1 and "tracked." on line 2 in italic `--color-prom-text-2`. A byline strip (LIVE dot + period + sync timestamp) sits between the masthead and the first section. Five sections with Roman numerals I–V — "Where we stand" is a 3-column hairline strip, "Money" is a 4-column hairline strip, "Acquisition economics" is a 6-column hairline strip; "Leverage" stays as three cards but with the refined treatment. The sparkline gains the dashed average-1.84× reference line with a tiny "avg 1.84×" label, a terminal accent dot at the most recent data point, and a slightly thinner stroke.

## Verification checklist (from README)

- ✅ H1 reads "Every dollar, tracked." at ~86px with the second word in italic on its own line.
- ✅ All 5 sections show a left-margin slug — I · MONTHLY PACE, II · LEVERAGE, III · MONEY, IV · ACQUISITION ECONOMICS, V · DAILY · LAST 30 DAYS.
- ✅ "Where we stand" is a 3-column hairline strip (no rounded card).
- ✅ Money is a 4-column hairline strip (no rounded cards) with 44px serif numerics; the Profit cell no longer takes the accent color.
- ✅ Acquisition is a 6-column hairline strip with 38px serif numerics; eyebrow min-height keeps single- and two-line labels aligned.
- ✅ Leverage cards have a 54px serif accent number and **no progress bar**, with italic curly-quoted coaching text.
- ✅ Sparkline shows a dashed average line + terminal accent dot.
- ✅ No new color or spacing tokens added to `[data-theme="promethean"]` — only utility classes.
- ✅ Other Promethean pages still render (`/closers`, `/setters`, `/inbox`, `/marketing`, etc.) — they share `PromSection` + `PromCard` + `KpiCard` + `LeverageCard`, and the enhancements are additive (new optional props, new classes). Build pass confirms no breakage; visual spot-check happens at the Vercel preview URL.

## Anything PROMPT.md / README.md asked for that I did NOT do

**Nothing material was skipped.** Two small judgment calls noted up front:

- The README left it open whether to drop `current` / `target` from `LeverageCard`'s type signature ("either path is acceptable"). I kept them as optional props (back-compat) and simply ignore them in the render. The bundle endorsed this choice.
- The README left the lift-footer color choice as bikeshed-level ("`--color-prom-pos` is fine; `--color-prom-accent` is fine too — preserve current behavior"). I used `--color-prom-pos` because the README's primary spec line for the lift footer specified `--color-prom-pos`, and it's a hair dimmer than the accent which keeps the hierarchy correct.

The visual reference HTML (`lithium/design_handoff_promethean_overview_broadsheet/overview-broadsheet.html`) and the JSX reference (`reference/v1-broadsheet.jsx`) were read for measurements and structure. I did NOT copy any of that code verbatim — the bundle's "Critical reminder — fonts" was explicit that the reference uses Newsreader + JetBrains Mono only for prototyping, and that everything should land through Instrument Serif (already wired) and the existing Promethean primitives. That's what I did.

## Surprises and judgment calls

- **The italic word position.** The bundle says "wrap the second word in `<em>…</em>` and force a `<br />` after the comma." That produces "Every dollar," on line 1 and "tracked." on line 2 in italic dimmer text — which matches the reference HTML when I cross-checked. I implemented exactly that.
- **`PromBylineStrip` is a new helper, not just inline JSX in `page.tsx`.** The README described the byline strip as part of `PromPageHeader`'s output. I extracted it to a separate `<PromBylineStrip>` helper so the masthead-without-byline use case (e.g., other Promethean pages whose page headers don't need a LIVE dot) doesn't get the rule above + below treatment forced on them. `PromPageHeader` itself stays scoped to the eyebrow / H1 / deck composition; the byline rendering opts in. This is additive and matches the README's "enhance, don't replace" rule — no existing call site breaks.
- **The "Where we stand" strip's middle column.** The README implied the col layout `1fr 1fr 1.4fr` and gave specific paddings (`32px 32px 32px 0` for col 1, `32px` for col 2, `32px 0 32px 32px` for col 3). I followed that exactly. The middle column's "MTD CASH COLLECTED" uses the dotted-top-border separator the spec asked for between the number and the "VS LAST MONTH | +18%" delta row.
- **No Gregory regressions expected.** Gregory's surfaces (`/clients`, `/calls`, `/ella/runs`, `/login`) share `app/(authenticated)/layout.tsx` and `components/authenticated-shell.tsx` — both untouched. None of the design changes leak there. The build's static-route count for Gregory is unchanged.

## Out of scope / deferred

- **Other Promethean sub-pages.** They inherit the primitive enhancements (no progress bar on `LeverageCard`, new section header layout, etc.). They will look subtly different after this pass — the closer-detail page in particular uses `LeverageCard` with `current` / `target` previously rendering a progress bar; that bar is now gone everywhere. The README explicitly said "verify they still render but do not modify them" — I didn't visually verify each surface myself (that's the Vercel preview pass), but the build passes and the call sites are valid. If a downstream page reads visually worse without the progress bar, that's a separate pass.
- **Mobile responsiveness.** The broadsheet pattern is desktop-first, like the rest of Promethean. The 6-column acquisition strip will get cramped below ~1100px. The bundle didn't ask for mobile adjustments; out of scope.
- **Visual verification against the reference HTML at the same zoom.** That's Drake's verification step at the preview URL.

## Side effects

**None outside the repo.** No external API calls, no Slack posts, no DB writes, no env-var changes, no `vercel.json` changes, no migrations. Two commits pushed to `origin/promethean-shell` (`800056b`, `5690d1c`) plus the report commit. The `lithium.zip` and `lithium/` folder Drake dropped at the repo root remain untracked — I didn't add them to any commit and didn't move them.

Vercel will auto-deploy `promethean-shell` from the push. With `PROMETHEAN_PUBLIC_PREVIEW=true` already set on the preview env, the new build will render the broadsheet refinement without any login flow on the preview URL.

## Drake's verification

1. Wait for Vercel's preview deploy of `promethean-shell` to finish (or trigger a manual redeploy if needed).
2. Open the preview URL → `/promethean` in incognito. Compare side-by-side with `lithium/design_handoff_promethean_overview_broadsheet/overview-broadsheet.html` opened in a separate tab at the same zoom (the reference is a 1440px artboard).
3. Walk the verification checklist above. If anything looks materially off vs the reference, point me at the specific section + the corresponding visual and I'll iterate.
4. Spot-check `/promethean/closers`, `/promethean/setters/[id]`, `/promethean/closers/[id]` to confirm the primitive changes didn't make those surfaces worse (the closer-detail leverage cards in particular).
5. Production check: open `https://ai-enablement-sigma.vercel.app/clients` in another incognito tab → still redirects to `/login`. The bypass stays scoped to `promethean-shell`.
