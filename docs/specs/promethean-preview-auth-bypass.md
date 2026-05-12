# Promethean preview — temporary auth bypass for Claude Design access
**Slug:** promethean-preview-auth-bypass
**Status:** in-flight
**Target branch:** `promethean-shell` (NOT main)

## ⚠️ Branch routing — read first

This spec lives on `main` but executes on `promethean-shell`. Before any code work:

1. Confirm you're on `promethean-shell` locally: `git fetch origin && git checkout promethean-shell && git pull origin promethean-shell`. If the branch doesn't exist locally yet, `git fetch origin && git checkout -b promethean-shell origin/promethean-shell`.
2. ALL code commits land on `promethean-shell`, NOT main.
3. The report at the end of this work lands on `promethean-shell` at `docs/reports/promethean-preview-auth-bypass.md`.
4. The spec itself stays on `main` as part of the canonical executable queue — do NOT copy or move the spec file.

This is the first feature-branch-only spec under a new working norm: "Director writes specs to main; Builder routes execution to the correct branch per spec." If you (Builder) are confused about which branch a spec targets, the spec's `Target branch:` field at the top is canonical. If it says anything other than `main`, switch there before doing code work.

## Context

Drake is iterating on the Promethean V0 visual design via Claude Design. Claude Design can ingest a live URL to extract DOM, CSS variables, typography, and component shapes — meaningfully higher fidelity than working from screenshots. But the `promethean-shell` Vercel preview URL is currently behind the Gregory Supabase Auth gate (via `app/(authenticated)/layout.tsx`), and Claude Design can't authenticate.

This spec adds a tightly-scoped auth bypass to the `promethean-shell` preview deployment only, so Claude Design can read the live site. The bypass is double-locked: a code conditional that only fires if an env var is set, AND the env var is scoped in Vercel to Preview environment + `promethean-shell` branch only. Production and main are not affected because the env var isn't set there even if the code accidentally propagates.

**Risk frame:** Drake has accepted the residual risk (his real-data exposure on Gregory routes is low and the preview URL is not widely known). The bypass is intentional, temporary, and reversible. The spec exists to make sure the implementation matches the risk profile Drake accepted — not to relitigate the call.

**Drake-confirmed design:**
- Bypass mechanism: env-var-gated conditional in `app/(authenticated)/layout.tsx`. Env var name: `PROMETHEAN_PUBLIC_PREVIEW`. Set to `'true'` only on Vercel Preview environment, scoped to branch `promethean-shell`.
- Code conditional checks `process.env.PROMETHEAN_PUBLIC_PREVIEW === 'true'`. If true: skip the `supabase.auth.getUser()` + redirect, render the layout directly.
- When the env var is unset (production, main-branch previews, any other branch preview), the existing auth flow runs unchanged.
- This is a Builder-only code change. Drake handles the Vercel env-var step himself (Builder cannot reach Vercel project settings).

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. `git status` and `git branch` show you're on `promethean-shell`, not `main`. If not, follow the branch routing instructions at the top of this spec.
2. Read `app/(authenticated)/layout.tsx` in full (the version on `promethean-shell`, which may differ from main). Identify the exact location of the `supabase.auth.getUser()` call and the `redirect('/login')` branch. The bypass conditional needs to short-circuit BEFORE those calls fire — including before the Supabase client is even instantiated, so an unset env var on a normal preview deployment doesn't waste a round trip.
3. Confirm the layout is a server component (no `'use client'` directive). The env-var read happens server-side at request time, which is what we want — `process.env` is server-only and the conditional evaluates per-request on Vercel.
4. Confirm there's no test harness that exercises the auth layout's redirect behavior. If there is, the test needs to know the bypass exists. (There likely isn't — `app/(authenticated)/layout.tsx` is server-rendered and not test-covered today.)
5. Confirm `next.config.js` / `next.config.mjs` doesn't have anything that would inline `process.env.PROMETHEAN_PUBLIC_PREVIEW` at build time in a way that bakes the value into static assets. The env var should be read at runtime, not build time. (Default Next.js behavior is runtime for server components, so this is almost certainly fine — just confirm by reading the config.)

## Work

### Step 1 — Add the bypass conditional to `app/(authenticated)/layout.tsx`

The exact placement: at the very top of the layout component function, before any Supabase client instantiation. The conditional renders the existing layout body directly (whatever the current `return` statement renders after a successful auth check) and returns, skipping the entire auth flow below.

Pseudocode shape (Builder reads the actual file on `promethean-shell` and adapts):

```tsx
export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // TEMP: bypass auth on promethean-shell preview for Claude Design access.
  // Removed when Promethean V0 visual iteration is complete.
  // Env var is scoped in Vercel to Preview environment + promethean-shell branch only.
  // See docs/known-issues.md § "Temporary work in progress" for removal procedure.
  if (process.env.PROMETHEAN_PUBLIC_PREVIEW === 'true') {
    return <AuthenticatedShell>{children}</AuthenticatedShell>
  }

  // Existing auth flow below — unchanged.
  const supabase = createServerClient(...)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  return <AuthenticatedShell>{children}</AuthenticatedShell>
}
```

The exact return shape inside the conditional MUST match what the existing layout returns after a successful auth check. Don't simplify or restructure — render whatever the existing body renders identically. If the file's actual return is more complex than `<AuthenticatedShell>{children}</AuthenticatedShell>`, mirror it exactly.

**Code comment matters here.** The conditional needs a clear `TEMP:` comment explaining what it does, why, when it gets removed, and a pointer to the known-issues entry. A future Director or Builder reading the file should immediately understand this isn't permanent.

### Step 2 — Verify the build still passes

```bash
npm run build
```

Expected: clean build, no type errors, no warnings about the conditional. The route table should still show `/clients`, `/calls`, `/promethean/*` etc. as before — the auth check is preserved, just gated.

### Step 3 — Commit and push to `promethean-shell`

```bash
git add app/\(authenticated\)/layout.tsx
git commit -m "promethean: temp auth bypass for promethean-shell preview (env-var gated)"
git push origin promethean-shell
```

One commit, one logical change. Vercel will auto-deploy the new preview. The auth flow still applies because Drake hasn't set the env var yet — the bypass doesn't activate until step 4.

### Step 4 — Drake sets the env var (Builder does NOT do this)

After Builder reports the commit is pushed, Drake handles the Vercel side:

1. Vercel dashboard → ai-enablement project → Settings → Environment Variables.
2. Add new variable: `PROMETHEAN_PUBLIC_PREVIEW` = `true`.
3. Scope: **Preview environment only.** Within preview, set the branch filter to `promethean-shell` specifically (Vercel allows per-branch env var scoping in the variable's advanced settings — see Vercel docs).
4. Save.
5. Trigger a redeploy on the `promethean-shell` branch (Vercel dashboard → Deployments → find the latest `promethean-shell` deploy → Redeploy. Do NOT need to uncheck build cache; this is a config change, not a code fix).
6. Once green, hit the preview URL in incognito. Expected: lands on `/promethean` directly with no login flow.

Builder's job ends at step 3. Step 4 is Drake's hands-on Vercel work.

### Step 5 — Verification after Drake's env-var work (Drake does this)

Two quick checks Drake runs after the redeploy:

1. **`promethean-shell` preview without auth:** open the preview URL in incognito → should land on `/promethean` directly. Click around Promethean surfaces freely. ✅ bypass is active.
2. **Main / Production still gated:** open `https://ai-enablement-sigma.vercel.app/clients` in a separate incognito → should redirect to `/login` as normal. ✅ bypass is NOT leaking to production.

If both pass, Drake passes the preview URL to Claude Design and proceeds with visual iteration.

## Hard stops

- **Do NOT commit to `main`.** All code commits land on `promethean-shell`. If you find yourself on main, `git checkout promethean-shell` before doing any work.
- **Do NOT change anything in `app/(authenticated)/layout.tsx` beyond adding the conditional at the top.** The existing auth flow stays exactly as is. If the file structure makes the conditional placement awkward (e.g., the auth check happens inside a try/catch or a helper function), surface to Drake — don't restructure the file to make the conditional fit.
- **Do NOT add the conditional anywhere else.** This is a single-file change. If you're tempted to add a similar bypass to `app/(authenticated)/clients/[id]/page.tsx` or anywhere else, stop — the layout-level bypass covers all child routes.
- **Do NOT touch `vercel.json`.** Env vars are configured in the Vercel dashboard, not in `vercel.json`. Even if `vercel.json` has env var entries, leave them alone.
- **Do NOT set the env var yourself.** Builder doesn't have Vercel dashboard access from the terminal. Even if you could (e.g., via Vercel CLI), don't — Drake handles step 4 explicitly so the trust chain stays clear.
- **Do NOT merge `promethean-shell` to `main` while this conditional exists.** When the Promethean V0 iteration wraps and we're ready to merge, the conditional has to be reverted first OR the merge happens with the understanding that the env var is also being deleted before the merge lands. Either path is acceptable; both have to be explicit. Surface this to Drake at merge time.
- **Do NOT delete or move the spec file from `main`.** The spec stays at `docs/specs/promethean-preview-auth-bypass.md` on main as part of the canonical executable queue. The Status flip (in-flight → shipped) on main happens after the report on `promethean-shell` lands — that's the next spec, not this one.

## What could go wrong

- **The env var leaks to production.** Mitigation already baked in: the env var is scoped in Vercel to Preview + `promethean-shell` branch only. Even if the code conditional lands on main, the env var being unset means it evaluates false and the auth flow runs normally. Two locks.
- **`process.env.PROMETHEAN_PUBLIC_PREVIEW` evaluates to a truthy string other than `'true'` somehow.** The strict `=== 'true'` check prevents this. Don't use just `if (process.env.PROMETHEAN_PUBLIC_PREVIEW)` — that triggers on any non-empty string, which is a wider failure mode.
- **A different branch's preview accidentally inherits the env var.** Vercel's per-branch env var scoping is the safeguard. Drake confirms branch-specific scope during step 4. If Vercel UI doesn't expose per-branch scoping clearly, fall back to scoping to Preview broadly + accept that other preview branches will also bypass auth — they'll still be on non-public branch names, and Drake controls which branches exist.
- **Claude Design can't actually read the URL despite no auth.** Possible if the live page has client-side gating, redirects, or rendering that depends on state Claude Design can't trigger. Mitigation: hit the URL in incognito yourself first — if you can see the page without logging in, so can Claude Design. If you see it but Claude Design can't, the issue is something else (CORS, rate limiting, Vercel's bot detection), not the auth bypass.
- **Drake forgets to remove the bypass when done.** Mitigation: the known-issues entry is the persistent reminder. The conditional has a clear `TEMP:` comment in the code. When the Promethean V0 visual iteration wraps, the conditional gets reverted along with the env var being deleted from Vercel.
- **Builder commits to main accidentally.** This is what the branch routing section + hard stop guards against. If it happens anyway: surface immediately to Drake, do NOT push. Recovery is a local branch reset, not a public revert.

## Mandatory doc updates

These doc updates happen on `promethean-shell` alongside the code change, NOT on main.

- **`docs/known-issues.md`** (on `promethean-shell`, not main) — add an entry under a new "Temporary work in progress" section (or just at the top) noting:
  - Auth bypass exists on `app/(authenticated)/layout.tsx` gated by `PROMETHEAN_PUBLIC_PREVIEW` env var.
  - Active on `promethean-shell` branch preview only.
  - Reason: Claude Design URL access for Promethean V0 visual iteration.
  - Removal trigger: when Promethean V0 visual iteration completes OR when `promethean-shell` is ready to merge to main (whichever comes first).
  - Removal procedure: revert the conditional + delete the env var from Vercel dashboard.
- **No `state.md` update.** This is a transient work-in-progress thing, not a system-state shift.
- **No `CLAUDE.md` update.**

## Commit + report

Per CLAUDE.md § Commits, one logical change per commit. All commits land on `promethean-shell`. Suggested:

- `promethean: temp auth bypass for promethean-shell preview (env-var gated)` — the layout.tsx change.
- `docs: log temporary Promethean auth bypass in known-issues.md` — the doc update.
- `docs: add report for promethean-preview-auth-bypass` — the report.

Bundle the first two if they feel coupled.

Report at `docs/reports/promethean-preview-auth-bypass.md` (on `promethean-shell`). Include:

- The exact line(s) added to `app/(authenticated)/layout.tsx` (paste the conditional).
- Confirmation that `npm run build` passes.
- The commit SHA of the bypass change.
- A reminder for Drake: "Add `PROMETHEAN_PUBLIC_PREVIEW=true` env var in Vercel for Preview + `promethean-shell` branch, then redeploy. Verify in incognito that `/promethean` loads without login AND that production `/clients` still redirects to `/login`."
- A removal-procedure note for the eventual cleanup: revert this commit + delete the env var.
- A flag for Director: "spec on main at `docs/specs/promethean-preview-auth-bypass.md` should be flipped from in-flight → shipped after this report lands. Either a separate spec on main handles the flip, or the next time Director writes a spec on main they update this status flag in the same commit."
