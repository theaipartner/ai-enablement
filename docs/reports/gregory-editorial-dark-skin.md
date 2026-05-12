# Report: Gregory editorial-dark visual reskin
**Slug:** gregory-editorial-dark-skin
**Spec:** docs/specs/gregory-editorial-dark-skin.md
**Branch:** `gregory-editorial-skin` (cut from `main`'s HEAD)

## Files modified

**Created**

- `docs/reports/gregory-editorial-dark-skin.md` — this file.

**Modified**

- `app/globals.css` — added the `[data-theme="gregory-editorial"]` token block, utility classes, and theme-scoped Tailwind palette overrides. Existing `:root` / `.dark` / Promethean-shaped shadcn `@theme inline` block untouched.
- `app/layout.tsx` — hoisted Instrument Serif + Inter via `next/font/google`, exposed as `--font-prom-serif` / `--font-prom-sans` on `<body>` alongside the existing Geist locals. Per spec Step 1 path (a) — option (a) is the cleaner long-term shape and didn't require any refactoring.
- `app/(authenticated)/layout.tsx` — added `data-theme="gregory-editorial"` attribute on the wrapper div + an inline style applying the editorial background and text color. Auth flow / `TopNav` rendering unchanged.
- `app/login/page.tsx` — wrapped `<LoginForm />` in a `data-theme="gregory-editorial"` div so the login surface picks up the theme even though `/login` lives outside `(authenticated)`. Auth-bounce logic unchanged.
- `app/login/login-form.tsx` — full visual restyle: masthead pattern (LIVE pulse + small-caps wordmark) + 64px serif "Sign in." headline + italic deck + form on a hairline-bordered card with small-caps field labels and electric-blue primary button. Form submission logic unchanged.
- `components/top-nav.tsx` — full visual restyle: serif "Gregory" wordmark, LIVE pulse dot, dark chrome with hairline bottom border, electric-blue underline as the active-nav indicator (computed via `usePathname`), small-caps muted email, outlined logout button. Logout flow unchanged.
- `components/client-detail/section.tsx` — restyled the collapsible `<details>` Section primitive: serif section title at 22px in the gregory section-title scale, muted chevron at 10px, slightly tighter top/bottom padding. Native `<details>`/`<summary>` collapsibility preserved.
- `app/(authenticated)/clients/page.tsx` — page header rebuilt to eyebrow + serif pattern (`CSM · CLIENTS` / `All clients.`) with a hairline-bordered base and small-caps count on the right. Filter bar and table props unchanged.
- `app/(authenticated)/clients/[id]/page.tsx` — page header rebuilt (`CLIENT · DETAIL` / `{client.full_name}`). Removed the first `<Separator />` between header and IdentitySection because the header now carries its own bottom border. All other `<Separator />` rules between sections preserved.
- `app/(authenticated)/calls/page.tsx` — page header rebuilt (`CSM · CALLS` / `All calls.`).
- `app/(authenticated)/calls/[id]/page.tsx` — page header rebuilt (`CALL · DETAIL` / `{title}` + small-caps meta).
- `app/(authenticated)/ella/runs/page.tsx` — page header rebuilt (`ELLA · AUDIT` / `Run history.`).
- `app/(authenticated)/ella/runs/[id]/page.tsx` — page header rebuilt (`ELLA · RUN` / `Run detail.` + small-caps run-id meta).
- `docs/state.md` — appended a "Gregory editorial skin in flight" section per the spec's mandatory-doc-updates list.

## Files NOT touched — scope confirmation

- ✅ **No file under `components/promethean/`** — does not exist on this branch (cut from main, which doesn't have Promethean).
- ✅ **No file under `app/(authenticated)/promethean/`** — does not exist on this branch.
- ✅ **No data layer touched.** Zero changes to: any RPC, any Server Action (`updateClientStatusAction`, `updateClientJourneyStageAction`, `updateClientCsmStandingAction`, `updateClientField`, `updateClientPrimaryCsm`, etc.), any migration (no new SQL), any vocab in `lib/client-vocab.ts`, any schema doc, any of `lib/db/clients.ts` / `lib/db/calls.ts` / `lib/db/ella-runs.ts` / `lib/db/merge.ts`. Verified by `git diff --stat main..HEAD` — only paint + tokens.
- ✅ **No layout change.** Surface order unchanged. Column order on `/clients` (Name / Status / Journey stage / Primary CSM / CSM Standing / NPS standing / Trustpilot / Health score / Meetings this mo) preserved. Section order on `/clients/[id]` (Identity / Lifecycle / Financials / Activity / Profile / Adoption / Notes) preserved. Filter bar dropdown order preserved.
- ✅ **No information change.** Same data, same row counts, same fields, same dropdowns, same editable cells, same pills, same buttons. Only HOW it renders, never WHAT.
- ✅ **No new shadcn primitive imported.** `components/ui/` untouched. The existing `Button`, `Input`, `Label`, `Table`, `Badge`, `Card`, `Separator`, `DropdownMenu`, `Select`, `Dialog`, `Textarea` primitives all auto-flip via the shadcn-token overrides under the gregory-editorial scope.
- ✅ **No new third-party dependency.** `package.json` unchanged. Instrument Serif + Inter come via the already-installed `next/font/google` package.
- ✅ **Auth flow, auth bypass, env vars, Vercel project settings** all untouched.

## Commits on `gregory-editorial-skin`

- `e6b5b24` — `gregory: add gregory-editorial theme tokens and hoist editorial fonts`
- `b721813` — `gregory: apply data-theme="gregory-editorial" to authenticated + login`
- `7c3fd1e` — `gregory: restyle TopNav and login form to editorial dark`
- `31d52f8` — `gregory: restyle page headers with eyebrow + serif pattern`
- `9e73c85` — `gregory: editorial section primitive + extra palette overrides`
- (report + state.md commit follows)

All pushed to `origin/gregory-editorial-skin`.

## `npm run build` status

**Clean.** Final run produced 9 routes (Gregory's full surface), no TypeScript errors, no ESLint warnings, no React warnings. Bundle sizes are within 1 kB of pre-reskin sizes per route — no bundle bloat from the reskin.

## Token list added to `globals.css` under `[data-theme="gregory-editorial"]`

### Color tokens
- `--color-geg-bg` (`#0a0a0a`) — page background
- `--color-geg-bg-elev` (`#16161a`) — elevated card surface
- `--color-geg-bg-elev-2` (`#1c1c20`) — deeper elevation (popovers, dropdowns)
- `--color-geg-border` (`rgba(245,244,239,0.08)`) — hairline rules
- `--color-geg-border-strong` (`rgba(245,244,239,0.14)`) — page separators, header divider
- `--color-geg-text` (`#f5f4ef`) — primary text (warm white)
- `--color-geg-text-2` (`rgba(245,244,239,0.60)`) — body sub-copy
- `--color-geg-text-3` (`rgba(245,244,239,0.40)`) — eyebrows, muted labels
- `--color-geg-accent` (`#0066ff`) — electric blue accent
- `--color-geg-accent-dim` (`rgba(0,102,255,0.16)`) — accent-tinted backgrounds
- `--color-geg-accent-strong` (`#1f7dff`) — brighter accent for text on dim backgrounds
- `--color-geg-pos` (`#0066ff`) — positive states (same as accent)
- `--color-geg-neg` (`#ff6b47`) — negative (red-orange, matches Promethean's negative)
- `--color-geg-neg-dim` (`rgba(255,107,71,0.16)`) — negative-tinted backgrounds
- `--color-geg-warn` (`#f4b740`) — warn (amber)
- `--color-geg-warn-dim` (`rgba(244,183,64,0.16)`)

### Shadcn token overrides (so every shadcn primitive auto-flips)
`--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`, `--border`, `--input`, `--ring`, `--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-accent`, `--sidebar-accent-foreground`, `--sidebar-border`, `--sidebar-ring`, `--radius` — all pointed at gregory-editorial color tokens.

### Utility classes
`.geg-serif`, `.geg-display`, `.geg-section-title` (28px serif H2 scale, slightly tighter than Promethean's 38px because Gregory's information density is higher), `.geg-deck` (italic editorial sub-copy), `.geg-numeric`, `.geg-numeric-serif`, `.geg-eyebrow`, `.geg-section-slug`. `.geg-pulse` keyframe for the LIVE indicator.

### Theme-scoped Tailwind palette overrides
- emerald-100/50/200 → electric-blue-tinted
- amber-100/50/200/300 → warn-tinted
- rose-100/50/200, red-600/500 → negative-tinted
- zinc-50/100/200/500/700/800, slate-100/200/300/700/800, gray-50/100/200/700/800 → editorial-muted
- sky-100/200, blue-100/50/200, blue-700/900 → accent-tinted
- white → bg-elev
- orange-900 → warn

## Font-loading path chosen

**Path (a)** — fonts hoisted to root `app/layout.tsx` via `next/font/google` and exposed as `--font-prom-serif` / `--font-prom-sans` on `<body>`. Cleaner long-term shape: both Gregory's editorial theme and (when its branch lands) Promethean's theme reference the same CSS variables. The font name kept the `--font-prom-*` prefix it had in Promethean rather than introducing a `--font-geg-*` alias — utility classes in both theme scopes already reference `--font-prom-serif`, so adding a redundant alias just creates an indirection nobody benefits from.

## Restyle path chosen per component family

Mixed per spec Step 3:

- **Path 1 (rewrite to semantic tokens / per-component edits)** — components where the visual change was substantial enough to warrant code edits: page headers (rebuilt with the eyebrow+serif pattern), TopNav (rebuilt with the serif wordmark + LIVE pulse + active-nav underline), login form (rebuilt with the masthead pattern), client-detail Section primitive (rebuilt with the serif title + muted chevron). These all live in files I would have had to edit anyway because their visual structure changed, not just their colors.
- **Path 2 (theme-scoped CSS overrides in globals.css)** — every hardcoded Tailwind palette class Gregory's pills and editable cells use: `bg-emerald-100 / text-emerald-900 / border-emerald-200`, plus the rose / amber / zinc / sky / blue / white / orange variants. Theme-scoped overrides remap them to the editorial palette without touching the pill component files (`StatusPill`, `JourneyStagePill`, `NpsStandingPill`, `TrustpilotPill`, `NeedsReviewPill`, `HealthScoreCell`, `TagsList`, the editable-cell wrappers).
- **Shadcn primitives** — auto-flipped via the shadcn token overrides under the gregory-editorial scope. Every Card, Button, Input, Label, Table (TableHeader / TableRow / TableCell), Badge, Separator, DropdownMenu, Select, Dialog, and Textarea instance in Gregory now renders editorial-dark without any component file change.

## Visual choices I made (judgment calls)

- **Section title scale (28px) vs Promethean's section title (38px).** Gregory's client-detail page has 7 sections that need to coexist on one scroll; Promethean's section titles sit on much sparser pages with broadsheet rhythm. Scaling Gregory's section title down keeps the page from feeling oversized.
- **`.geg-` class prefix.** Used `geg-` ("gregory editorial") instead of just `.eyebrow` / `.serif` etc. so when Promethean's branch eventually lands, the two prefixes don't collide. Both theme blocks coexist in `globals.css`; both reference the same `--font-prom-*` variables.
- **Login wordmark.** Used "GREGORY · LIVE" with the pulse dot to mirror Promethean's "Promethean · LIVE" masthead pattern. Could plausibly be "GREGORY" without the LIVE; kept the pulse because it telegraphs "live system" to Nabeel as a demo affordance.
- **TopNav active-nav indicator.** Used a 2px electric-blue underline at the bottom edge of the active nav item rather than a left-edge accent bar (Promethean's pattern). Reason: Gregory uses a top-horizontal nav (TopNav), not a left sidebar like Promethean. Left-edge accent bars don't read on horizontal nav.
- **Page header H1 sizes.** Top-level list pages get 52px (`All clients.` / `All calls.` / `Run history.`); detail pages get 48px (`{client.full_name}`) or 40px (`{call.title}` / `Run detail.`). Smaller than Promethean's 86px broadsheet display because Gregory's pages are denser and need less title weight to feel right.
- **Promethean fonts as `--font-prom-*` even on this Promethean-less branch.** Kept the variable names consistent so when the Promethean branch merges and references `--font-prom-serif` inside its theme block, the same fonts already exist. The naming reads slightly weird in isolation on this branch ("`--font-prom-*` for Gregory?") — the merge cohesion outweighs the local readability cost.

## Anything I did NOT do

Nothing material was skipped. Two scope decisions worth surfacing:

- **Login lives at `app/login/`, not under `(authenticated)`.** The acclimatization checklist's question 5 asked Builder to identify the layout root for the data-theme attribute and consider per-route-group scoping. I went with the parent-wrapper approach (data-theme on `(authenticated)/layout.tsx` for everything authenticated) plus an explicit wrapper on `app/login/page.tsx` for the login surface. Per-route-group scoping (separate data-theme on `/clients/layout.tsx`, `/calls/layout.tsx`, etc.) would have been more surgical but pointless on this branch — there's no Promethean route to exclude.
- **No fallback to path (b) for fonts.** Path (a) — root layout hoisting — worked cleanly on the first try. No structural issue surfaced.

## Side effects

**None outside the repo.** Specifically:

- No external API calls. No Slack posts, no DB writes, no migrations, no Anthropic / OpenAI calls.
- No env-var changes. No `vercel.json` / `next.config.mjs` / `package.json` changes.
- No effect on production until Drake merges this branch to main.
- `lithium.zip` and `lithium/` (the Promethean design-handoff bundle from earlier today) left untracked at repo root — untouched, not added to any commit.

Six commits pushed to `origin/gregory-editorial-skin`: `e6b5b24` (tokens + fonts), `b721813` (data-theme application), `7c3fd1e` (TopNav + login restyle), `31d52f8` (page headers), `9e73c85` (Section primitive + palette extras), plus the state.md + report commit.

Vercel will auto-deploy `gregory-editorial-skin` from the push. Preview URL surfaces in the Vercel dashboard once the build completes.

## Drake's verification

Walk the preview URL on every Gregory surface — `/login`, `/clients` (list), `/clients/[id]` (detail), `/calls` (list), `/calls/[id]` (detail), `/ella/runs` (list), `/ella/runs/[id]` (detail). Confirm:

- Editorial-dark aesthetic everywhere: warm-dark backgrounds, near-white text, electric-blue accents (active nav underline, primary buttons, LIVE pulse, NPS standing pills).
- Page headers all show the eyebrow + serif headline pattern.
- TopNav active-nav underline tracks correctly when you click between Clients / Calls / Ella.
- Pills (status, journey stage, NPS standing, Trustpilot, health-score tier) read in the editorial palette — no more raw emerald / amber / rose Tailwind colors.
- Tables look right under dark mode (no white flashes, hover lift readable).
- Forms render correctly on `/login` and inline-edit dropdowns on `/clients`.
- Information density preserved — no row-height blowups on the clients list.

**Promethean coexistence check NOT applicable on this branch** — Promethean code doesn't exist here. The coexistence question lives at the merge point: when both feature branches merge to main, the two `[data-theme="..."]` scopes coexist via their distinct selectors. No expected conflict; both reference the same `--font-prom-*` font variables and have non-overlapping class prefixes (`.prom-*` vs `.geg-*`) and non-overlapping color-token prefixes (`--color-prom-*` vs `--color-geg-*`).

If anything looks off, point me at the specific surface + the visual issue and I'll iterate. Otherwise: decide whether to merge `gregory-editorial-skin` to `main` (after `promethean-shell` merges or before; order doesn't matter because the two theme scopes are independent) or to continue iterating on visual polish on this branch first.
