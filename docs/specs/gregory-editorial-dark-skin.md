# Gregory editorial-dark visual reskin (Promethean aesthetic, electric blue accent)
**Slug:** gregory-editorial-dark-skin
**Status:** in-flight
**Target branch:** `gregory-editorial-skin` (NOT main, NOT promethean-shell)

## ⚠️ Branch routing — read first

This spec lives on `main` but executes on a NEW feature branch `gregory-editorial-skin` cut from `main`'s current HEAD. Before any code work:

1. `git fetch origin && git checkout main && git pull origin main` — start from main's latest.
2. `git checkout -b gregory-editorial-skin` — create the new branch.
3. `git push -u origin gregory-editorial-skin` — push the branch immediately so Vercel sees it and starts auto-deploying previews.
4. ALL code commits land on `gregory-editorial-skin`. NOT main. NOT promethean-shell.
5. The report at the end of this work lands on `gregory-editorial-skin` at `docs/reports/gregory-editorial-dark-skin.md`.
6. The spec itself stays on `main` as part of the canonical executable queue — do NOT copy or move the spec file.

This is the second feature-branch-only spec under the "Director writes specs to main; Builder routes execution to the correct branch per spec" working norm. If you (Builder) are confused, the `Target branch:` field at the top is canonical.

## Context

Drake wants Gregory to share Promethean's visual aesthetic — same editorial-dark theme, same serif headlines, same warm-dark backgrounds, same small-caps labels — but with **electric blue (`#0066FF`)** as the accent color instead of Promethean's yellow-green. The goal is product-family cohesion: when Nabeel sees both products, they should feel like the same company.

**Scope: visual reskin only.** Drake's explicit constraint:

> I want these same style and design changes to be made to gregory dashboard, but I want an electric blue as the accent colour. I want B but I dont want to change the layout, I want to change the look, the colours, fonts, boxes, only things like that.

This means:

- **In scope:** colors, fonts, card treatments, border styling, small-caps labels, page header pattern (eyebrow + serif headline), spacing within existing card shapes, the LIVE pulse pattern if relevant.
- **Out of scope:** layout changes, surface reorganization, section reordering, information architecture, new surfaces, removed surfaces, anything functional, anything that changes WHAT Gregory shows (only HOW it shows it).

There's separate Gregory UX architecture work queued (client detail reorg, editable toggles at top, calls list refactor, tags removal, etc.) that lives in a different spec. This reskin must NOT touch any of that — those are architecture changes; this is pure paint.

## Drake-confirmed scope

- **Branch:** `gregory-editorial-skin`, cut from `main`. Preview deploys auto-build on Vercel. When Drake approves the preview, merge to `main`.
- **Theme implementation:** **Option Y** — parallel `[data-theme="gregory-editorial"]` block in `app/globals.css`, distinct from Promethean's `[data-theme="promethean"]`. Same warm-dark foundation; the accent variable is the meaningful difference.
- **Accent color:** `#0066FF` electric blue. Use for: positive numbers, active nav indicators, primary buttons, focus rings, anywhere Promethean uses yellow-green.
- **Negative accent:** unchanged from Promethean's red-orange (around `#e74c3c` / `#ff6b47`). Negative states should match across the two products.
- **All Gregory surfaces in scope:** `/clients` (list), `/clients/[id]` (detail), `/calls` (list), `/calls/[id]` (detail), `/ella/runs`, `/ella/runs/[id]`, `/login`. Login page converts too for product-demo consistency.
- **Coexistence with Promethean:** Promethean's `[data-theme="promethean"]` scope and all Promethean code stays untouched. Both themes live in `app/globals.css` side-by-side. Promethean continues to look exactly as it does today.
- **Mock data, RPCs, Server Actions, data shapes, query patterns:** zero changes. This is paint, not plumbing.

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. `git status` and `git branch` show you're on `gregory-editorial-skin`, cut from `main`'s latest. If not, follow the branch routing instructions at the top.
2. Read `app/globals.css` in full, paying particular attention to the existing `[data-theme="promethean"]` block. The Gregory editorial theme will mirror its token structure with the accent swapped to electric blue. Capture the full Promethean token list for comparison.
3. Read `components/promethean/primitives.tsx` (on `promethean-shell` branch — you may need to git fetch / git show that branch's version since `gregory-editorial-skin` is cut from `main` which doesn't have Promethean). Identify the primitive patterns to mirror in Gregory: PromPageHeader (eyebrow + serif headline), PromCard (elevated card), PromSection (titled section wrapper), KpiCard, DeltaPill, small-caps label pattern. **Don't copy these files into Gregory** — Gregory's existing components get restyled in place. The Promethean primitives are visual reference, not portable code.
4. Survey Gregory's existing component surface. Read in order: `app/(authenticated)/clients/clients-table.tsx`, `app/(authenticated)/clients/page.tsx`, `app/(authenticated)/clients/[id]/page.tsx`, the section components under `components/client-detail/`, `app/(authenticated)/calls/page.tsx`, `app/(authenticated)/calls/[id]/page.tsx`, `app/(authenticated)/ella/runs/page.tsx`, `app/(authenticated)/ella/runs/[id]/page.tsx`, `app/(authenticated)/login/page.tsx`. Build a mental map of: (a) which components reference Tailwind utilities directly (`bg-white`, `text-gray-900`) vs semantic tokens (`bg-card`, `text-foreground`), and (b) which shared shadcn primitives Gregory uses (`Card`, `Button`, `Input`, etc.).
5. Identify the Gregory layout root that should receive the `data-theme="gregory-editorial"` attribute. Most likely `app/(authenticated)/layout.tsx` for everything authenticated EXCEPT the Promethean route group (which keeps its own theme via its sub-layout). Alternative: scope the data-theme to Gregory's route groups specifically (e.g., add the attribute to `app/(authenticated)/clients/layout.tsx`, `app/(authenticated)/calls/layout.tsx`, etc.). The first approach is simpler; the second is more surgical. **Builder picks** based on what reads cleanly from the actual file structure — surface the choice in the report.

## Work

### Step 1 — Add the `[data-theme="gregory-editorial"]` token block to `app/globals.css`

Mirror Promethean's existing token structure exactly, but with `#0066FF` substituted for the accent color. Naming convention: prefix tokens with `--color-gregory-` to keep them separate from Promethean's `--color-prom-` tokens. The two themes coexist; there's no shared token unless we explicitly want one.

Skeleton of what the block looks like (Builder reads Promethean's actual block first and adapts — values below are illustrative, NOT to be copied as-is):

```css
[data-theme="gregory-editorial"] {
  --color-gregory-bg: #0a0a0a;
  --color-gregory-bg-elev: #16161a;
  --color-gregory-bg-elev-2: #1c1c20;
  --color-gregory-text: #f5f4ef;
  --color-gregory-text-2: rgba(245, 244, 239, 0.6);
  --color-gregory-text-muted: rgba(245, 244, 239, 0.4);
  --color-gregory-border: rgba(245, 244, 239, 0.08);
  --color-gregory-accent: #0066FF;
  --color-gregory-accent-dim: rgba(0, 102, 255, 0.15);
  --color-gregory-negative: #e74c3c;
  --color-gregory-negative-dim: rgba(231, 76, 60, 0.15);
  /* Plus any additional tokens Promethean defines: pill backgrounds, hover states, etc. */

  /* Typography variables — reuse Promethean's font stacks */
  --font-gregory-serif: var(--font-prom-serif);
  --font-gregory-sans: var(--font-prom-sans);

  background: var(--color-gregory-bg);
  color: var(--color-gregory-text);
}
```

**If Promethean defines additional state tokens** (hover backgrounds, focus rings, etc.), mirror them. The two theme blocks should have parallel structure.

**The fonts.** Promethean's serif (Instrument Serif) is loaded via `next/font/google` in `app/(authenticated)/promethean/fonts.ts` and exposed as `--font-prom-serif`. Gregory needs access to the same font. Two paths:

- **(a) Reuse Promethean's font definitions globally.** Move the font loading from `app/(authenticated)/promethean/fonts.ts` up to `app/layout.tsx` (the root layout) so both Gregory and Promethean access the same CSS variables. Promethean's existing reference to `--font-prom-serif` keeps working unchanged.
- **(b) Duplicate the font loading for Gregory.** Add a `gregory/fonts.ts` that loads the same fonts as `--font-gregory-serif`. More code; same network request (Next.js dedupes Google Fonts requests).

**Builder picks (a)** unless it surfaces a structural problem during implementation. Option (a) is the cleaner long-term shape; option (b) is the fallback if (a) requires more refactoring than expected.

### Step 2 — Apply the data-theme attribute to Gregory's route scope

Modify the layout that wraps Gregory's authenticated routes. The cleanest path: in `app/(authenticated)/layout.tsx`, conditionally apply `data-theme="gregory-editorial"` to the outer wrapper IF the route is NOT a Promethean route.

Pseudocode shape (Builder reads actual file and adapts — note that the existing layout already handles the Promethean route via `AuthenticatedShell`):

```tsx
// Inside AuthenticatedLayout's return:
return (
  <div className="min-h-screen" data-theme="gregory-editorial">
    <AuthenticatedShell userEmail={user.email ?? ''}>
      {children}
    </AuthenticatedShell>
  </div>
)
```

**Important:** the `data-theme` attribute on Gregory's wrapper should NOT cascade into Promethean's route group. Promethean's own layout under `app/(authenticated)/promethean/layout.tsx` explicitly sets `data-theme="promethean"` on its inner wrapper — this overrides any parent data-theme. Verify after Builder's changes that:

- `/clients` and other Gregory routes have `data-theme="gregory-editorial"` in the DOM
- `/promethean` and Promethean routes have `data-theme="promethean"` overriding

If the parent-wrapper approach causes any unexpected nesting issues, fall back to per-route-group attribute application (e.g., add the data-theme to the clients group, calls group, ella group, and login page individually). Surface the choice.

**Login page.** `app/(authenticated)/login/page.tsx` may sit outside the authenticated layout — depending on the routing structure. Builder verifies the login page picks up the gregory-editorial theme through whatever its parent is, OR applies the data-theme directly on the login page's root if necessary.

### Step 3 — Restyle Gregory's components to the editorial-dark aesthetic

This is the bulk of the work. For each component in scope, apply Promethean's visual patterns:

- **Page header pattern.** Wherever Gregory has a page title, restyle to: small-caps eyebrow label above + serif headline + meta strip below. Examples:
  - `/clients` list page header → eyebrow `CSM · CLIENTS` + serif `All clients.`
  - `/clients/[id]` detail page header → eyebrow `CLIENT · DETAIL` + serif `{client.full_name}`
  - `/calls` list page header → eyebrow `CSM · CALLS` + serif `All calls.`
  - `/ella/runs` → eyebrow `ELLA · AUDIT` + serif `Run history.`
  - Builder writes copy in the same voice for each surface; if a copy choice feels ambiguous, default to short declarative serifs and surface for Drake's review later.
- **Cards.** Existing card containers (Section 1 Identity, Section 2 Lifecycle, etc. on the client detail; row containers on lists; per-section blocks on `/ella/runs/[id]`) restyle to elevated dark cards: warm-dark background, generous padding, rounded corners (8px), subtle or no borders.
- **Tables.** Existing tables (clients-table, calls list, ella runs list) restyle to dark editorial table treatment: row separators very subtle, hover state slight bg lift, sort indicators preserved, pagination preserved. **Information density preserved** — don't increase row heights or padding to make it look like Promethean's setup. Gregory shows 188+ clients; spacing must accommodate that.
- **Pills.** Status pills, standing pills, journey-stage pills, sentiment pills — recolor to opacity-tinted backgrounds + matching text color. Match Promethean's pill shape: rounded-full, `px-2 py-0.5`, small text.
- **Buttons.** Primary buttons use electric-blue accent. Secondary borders + transparent bg + light text. Tertiary text-only.
- **Forms and inputs.** Login form fields, inline-editable cells, dropdowns, date pickers — all restyled to dark editorial: dark backgrounds, subtle borders, electric-blue focus rings.
- **Small-caps labels.** Section labels, column headers, sublabels in cards — apply small-caps treatment (uppercase + letter-spacing + muted color) to match Promethean.
- **Active nav indicator.** Whatever Gregory's nav uses (TopNav per `AuthenticatedShell`), the active item should get a left-edge or top-edge electric-blue accent bar + slightly brighter text.

**Where existing Gregory components use Tailwind utility classes directly** (`bg-white`, `text-gray-900`, etc.), two refactor paths:

- **Path 1 — rewrite to semantic tokens.** Change `bg-white` to a CSS variable reference or to a class that resolves correctly under the gregory-editorial scope. Cleaner long-term.
- **Path 2 — override via theme-scoped CSS.** In `globals.css` under `[data-theme="gregory-editorial"]`, add overrides like `.bg-white { background: var(--color-gregory-bg-elev) }`. Faster but creates cascade complexity.

Builder picks per component based on what feels right — Path 1 for primary components Gregory uses heavily (clients-table, page headers, cards), Path 2 for incidental places where a single utility class needs to flip. Surface the mix in the report.

### Step 4 — Verify Promethean is unchanged

Critical check. After all Gregory work:

- Navigate to `/promethean` (or any Promethean route) in a running dev session: still renders identically to pre-change Promethean.
- Inspect the DOM: `data-theme="promethean"` is present on Promethean routes, `data-theme="gregory-editorial"` is present on Gregory routes.
- No Promethean component file modified. `git status` and `git diff --stat` confirm zero changes under `components/promethean/` or `app/(authenticated)/promethean/`.

If Promethean is affected in any way, stop and surface. The two themes coexist; one must not affect the other.

### Step 5 — Verify the build + push

```bash
npm run build
```

Clean build expected. Type errors, lint errors, or runtime warnings all stop the push.

Once green:

```bash
git push origin gregory-editorial-skin
```

Vercel auto-deploys the branch. Drake reviews at the preview URL.

## Hard stops

- **Do NOT commit to `main` or `promethean-shell`.** All commits land on `gregory-editorial-skin`. If you find yourself on either, `git checkout gregory-editorial-skin` before any work.
- **Do NOT modify any file under `components/promethean/` or `app/(authenticated)/promethean/`.** Promethean is unaffected by this work. The reference is read-only.
- **Do NOT modify any data layer, RPC, Server Action, query, migration, vocab, or schema.** This is paint-only. If any visual change pushes you toward a data change, surface and stop.
- **Do NOT change the information shown.** What columns exist, what sections exist, what data renders — all unchanged. Only visual treatment.
- **Do NOT change the architecture work currently queued for Gregory.** There's separate work for client detail reorg, editable toggles at top, calls list refactor, tags removal, etc. That work will land separately on its own spec. This spec preserves Gregory's existing layout exactly — column order, section order, navigation order, all preserved.
- **Do NOT introduce new shadcn primitives or new third-party dependencies.** Reuse what's already in `components/ui/` and reshade them via tokens. If a primitive truly needs to be replaced (e.g., a Card primitive that's deeply tied to light-mode colors), surface and ask before swapping.
- **Do NOT touch Gregory's auth flow, the auth bypass, the env vars, or Vercel project settings.** This is a pure code-and-styling change.
- **Do NOT push to main or merge to main.** Drake decides when to merge after reviewing the preview.

## What could go wrong

- **Tailwind utility classes baked into components don't easily restyle via data-theme scoping.** Mitigation: identify the worst offenders during acclimatization (Step 5 of acclimatization). For the heavy hitters, refactor to semantic tokens. For incidental cases, override via theme-scoped CSS.
- **The auth flow (login → redirect) doesn't pick up the theme cleanly.** Login page may need its own data-theme application. Surface during implementation if it's awkward.
- **Existing shadcn components (`Card`, `Button`, `Input`) have light-mode defaults that need overrides.** Mitigation: scope the overrides under `[data-theme="gregory-editorial"]` in globals.css. Don't modify the shadcn primitives themselves.
- **Drake sees the preview and wants tweaks.** Expected. This spec produces V1; the polish iteration happens after Drake reviews. Don't over-polish; ship the core reskin and let Drake direct refinement.
- **The Promethean fonts aren't loaded for Gregory routes if the route doesn't pass through Promethean's font setup.** Mitigation: Step 1's font path (a) moves loading to root layout, accessible to both products.
- **`/login` is outside `(authenticated)` route group and doesn't get the data-theme attribute.** Verify the actual file location. If login is in a different route group, apply data-theme directly on the login page's root.
- **Tables look cramped under the editorial spacing because Gregory's row counts are 10x Promethean's.** Information density takes precedence over editorial breathing room. Gregory's tables stay dense; only the surrounding chrome (page header, filter bar, card containers) gets the editorial treatment.
- **Builder accidentally restyles something that's also used by Promethean (e.g., a shadcn primitive used by both).** Mitigation: scope all overrides via `[data-theme="gregory-editorial"]` selector, never globally. Promethean's `[data-theme="promethean"]` overrides will continue to apply on Promethean routes.

## Mandatory doc updates

These doc updates happen on `gregory-editorial-skin`, NOT on main.

- **`docs/state.md`** (on `gregory-editorial-skin`) — append a single line under a new "Gregory editorial skin in flight" section noting the branch name, the date, and the scope ("pure visual reskin, no layout/architecture changes"). Filled in further when Drake reviews and merges.
- **No `CLAUDE.md` update.** This is exploratory visual work, not a system shift.
- **No `known-issues.md` update.** No new known issues introduced; if any surface during work, log them as part of the report.
- **No new runbook.**

## Commit + report

Per CLAUDE.md § Commits, one logical change per commit. All commits land on `gregory-editorial-skin`. Suggested batched commits:

- `gregory: add gregory-editorial theme tokens to globals.css`
- `gregory: hoist Promethean fonts to root layout for shared access` (if path (a) of Step 1 was chosen)
- `gregory: apply data-theme to authenticated layout`
- `gregory: restyle page headers across Gregory surfaces (eyebrow + serif)`
- `gregory: restyle clients list + filter bar to editorial dark`
- `gregory: restyle client detail page sections to editorial dark`
- `gregory: restyle calls list + detail to editorial dark`
- `gregory: restyle ella/runs surfaces to editorial dark`
- `gregory: restyle login page to editorial dark`
- `docs: log Gregory editorial-skin work in progress in state.md`
- `docs: add report for gregory-editorial-dark-skin`

Bundle where natural; the principle is one logical change per commit.

Report at `docs/reports/gregory-editorial-dark-skin.md` on the branch. Include:

- The exact list of files modified.
- Confirmation that no files under `components/promethean/`, `app/(authenticated)/promethean/`, or any data layer (RPCs, Server Actions, migrations) were touched.
- Confirmation that Gregory's layout, surface order, column order, section order, and information shown are unchanged.
- The token list added to `globals.css` under `[data-theme="gregory-editorial"]`.
- Which font-loading path was chosen (Step 1 path (a) vs (b)) and why.
- Which restyle path was chosen for utility-class-bound components (Step 3 path 1 vs path 2) and the mix per component family.
- `npm run build` status (clean / warnings / errors).
- The Vercel preview URL for `gregory-editorial-skin`.
- Any visual choices that felt ambiguous and Builder made a judgment call on (font sizes, exact spacing, exact shades within tolerance).
- A reminder for Drake: review the preview URL on every Gregory surface, confirm Promethean still looks identical, then decide whether to merge to main or iterate further.
