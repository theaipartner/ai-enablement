# Report: Promethean preview — temporary auth bypass for Claude Design access
**Slug:** promethean-preview-auth-bypass
**Spec:** docs/specs/promethean-preview-auth-bypass.md

## Files touched

**Modified**

- `app/(authenticated)/layout.tsx` — added an env-var-gated short-circuit at the top of `AuthenticatedLayout`. When `process.env.PROMETHEAN_PUBLIC_PREVIEW === 'true'`, the layout renders the existing shell directly with an empty `userEmail` and returns; the existing `createClient()` / `getUser()` / `redirect('/login')` flow runs unchanged when the env var is unset or anything other than the literal string `'true'`.
- `docs/known-issues.md` — added a "Temporary work in progress" section with the Promethean preview auth bypass entry: what / why / next-action (revert + delete env var) / logged date.

**Created**

- `docs/reports/promethean-preview-auth-bypass.md` — this file.

## What I did, in plain English

Added an env-var-gated conditional at the very top of the authenticated layout so the Promethean preview URL on the `promethean-shell` branch can be opened without going through the Supabase login flow — but only when an env var explicitly enables it. The double-lock the spec asked for is preserved end-to-end: even if this conditional accidentally propagated to main, the env var wouldn't be set there and the auth flow would run normally.

The conditional renders the same `<AuthenticatedShell userEmail="">` wrapping the same `<div className="min-h-screen">` that the post-auth path renders, so the route-aware shell switcher (Gregory's TopNav for Gregory routes, Promethean's dark sidebar for `/promethean/*`) still works identically. `userEmail` is passed as an empty string in the bypass branch because there's no authenticated user — the existing TopNav handles an empty email by rendering nothing in that slot, and the Promethean shell's owner-footer falls back to a hardcoded `thomas@heliosscale.com` placeholder when `userEmail` is empty (which is exactly the demo-tenant identity).

Inline TEMP comment explains what the bypass does, when it gets removed, and points to the known-issues entry for the removal procedure. The known-issues entry mirrors the same removal contract — revert the conditional AND delete the env var from Vercel, both steps required.

Builder's portion of the spec ends at the push. Drake still has to set `PROMETHEAN_PUBLIC_PREVIEW=true` in Vercel scoped to Preview + `promethean-shell`, then redeploy and verify in incognito.

## Exact code added

```tsx
// TEMP: bypass auth on promethean-shell preview for Claude Design access.
// Removed when Promethean V0 visual iteration is complete OR when this
// branch is ready to merge to main (whichever comes first). The env var
// is scoped in Vercel to Preview environment + promethean-shell branch
// only — production and main-branch previews keep the auth gate.
// See docs/known-issues.md § "Temporary work in progress" for the
// removal procedure.
if (process.env.PROMETHEAN_PUBLIC_PREVIEW === 'true') {
  return (
    <div className="min-h-screen">
      <AuthenticatedShell userEmail="">
        {children}
      </AuthenticatedShell>
    </div>
  )
}
```

Inserted as the first statement inside `AuthenticatedLayout`, before `createClient()`. Everything below that line in the file is unchanged from the version on `promethean-shell` HEAD before this commit.

## Verification

- **`npm run build` clean.** Final run produced all 27 routes including 18 under `/promethean`. Build output mirrors the pre-bypass build exactly — same route table, same page sizes, no type errors, no lint warnings.
- **Strict equality check.** Conditional uses `=== 'true'` (the literal string), not truthy-coercion. Any other value (`'TRUE'`, `'1'`, `'yes'`, an empty string, undefined) falls through to the normal auth flow.
- **No structural restructuring.** The post-auth render branch (`<div className="min-h-screen"><AuthenticatedShell userEmail={user.email ?? ''}>...</AuthenticatedShell></div>`) is unchanged. The bypass branch mirrors it exactly with `userEmail=""` since there is no authenticated user in that path.
- **`next.config.mjs` confirmed default-empty.** No `env` block that would inline `PROMETHEAN_PUBLIC_PREVIEW` at build time. Server components read `process.env` at runtime, which is what we want.
- **No test harness touches this file.** Grepped `tests/` for `AuthenticatedLayout` / `AuthenticatedShell` / auth-layout patterns — zero matches. Nothing needed to be updated.

**Did NOT verify in a running deployment.** The bypass behavior is unverified until Drake sets the env var and redeploys. Builder cannot reach Vercel project settings to set env vars; that's gate (d) per CLAUDE.md.

## Commit SHA

- Bypass + known-issues: `2eeb33a` on `promethean-shell` (already pushed to `origin/promethean-shell`).
- Report (this file): committed and pushed as the next commit.

## Drake's next steps (manual, in Vercel)

1. Vercel dashboard → `ai-enablement` project → **Settings → Environment Variables**.
2. Add new variable: **Name** `PROMETHEAN_PUBLIC_PREVIEW`, **Value** `true`.
3. **Scope:** Preview environment only. Within Preview, set the **Git Branch** filter to `promethean-shell` (Vercel allows per-branch env var scoping in the variable's advanced settings).
4. Save.
5. Trigger a redeploy on `promethean-shell` (Vercel dashboard → Deployments → find the most recent `promethean-shell` deploy → Redeploy). No need to uncheck "Use existing Build Cache" — this is a config change, not a build fix.
6. Once green, open the preview URL in incognito:
   - **Expected on `<preview-url>/promethean`:** lands directly on the Overview, no login redirect. ✅ bypass active.
   - **Expected on `https://ai-enablement-sigma.vercel.app/clients`:** still redirects to `/login`. ✅ bypass is NOT leaking to production.
7. If both checks pass, the preview URL is ready to hand to Claude Design.

If Vercel's UI doesn't expose per-branch scoping, fall back to scoping the env var to Preview broadly. Per the spec, that's an accepted fallback — other preview branches would also bypass auth, but Drake controls which branches exist and which preview URLs are shared.

## Removal procedure (when V0 visual iteration completes)

Both steps required; neither alone is sufficient.

1. **Revert the conditional in code.** On `promethean-shell` (or wherever the conditional has landed by then), delete the `if (process.env.PROMETHEAN_PUBLIC_PREVIEW === 'true') { ... }` block from `app/(authenticated)/layout.tsx`. Commit with a clear message (`promethean: remove temp auth bypass — V0 iteration complete`). Push.
2. **Delete the env var in Vercel.** Vercel dashboard → ai-enablement project → Settings → Environment Variables → find `PROMETHEAN_PUBLIC_PREVIEW` → delete. Trigger a redeploy on `promethean-shell` to pick up the absence of the var (or wait for the next code push).

Also: remove the "Promethean preview — auth bypass" entry from `docs/known-issues.md § Temporary work in progress` in the same commit as step 1.

## Surprises and judgment calls

- **`userEmail=""` in the bypass branch.** The spec said "mirror exactly what the existing return renders." The existing return passes `user.email ?? ''` which resolves to a string. The bypass has no `user` object, so passing an empty string is the closest mirror — and the downstream components both tolerate it (TopNav renders the email as a `<span>` and an empty span is invisible; the Promethean sidebar falls back to a hardcoded placeholder). No fake user object constructed; no `as unknown as User` casting.
- **The known-issues entry slotted at the top.** Per the file's "Entry format" header convention (`What / Why it matters / Next action / Logged`), I matched that shape exactly and placed it under a new section heading just above the existing "NEXT SESSION FIRST ACTION" gate. Logged date is `2026-05-12` matching today.
- **The spec also exists at `docs/specs/promethean-preview-auth-bypass.md` on `promethean-shell`.** When I pulled `origin/promethean-shell` at the start of this run, the spec file came down as part of the merge. That contradicts the spec's own instruction ("do NOT copy or move the spec file"), but Director appears to have intentionally pushed the spec to both branches — possibly because the working norm of "spec stays on main only" hasn't been pulled forward to feature-branch-only specs yet. I did NOT modify or move the spec file. Flagging here so Director / Drake can decide whether the spec gets cleaned out of the feature branch separately, or whether the convention shifts to "spec lives on both branches when there's a feature-branch-targeted execution path."
- **Builder commits the `Status:` flip on main as a separate spec.** The spec said "spec on main should be flipped from in-flight → shipped after this report lands. Either a separate spec on main handles the flip, or the next time Director writes a spec on main they update this status flag in the same commit." I did NOT touch the spec file on main — that's Director's call on cadence. Surfacing it here as the flag the spec explicitly asked for.

## Out of scope / deferred

- **Builder does NOT set the Vercel env var.** Gate (d). Drake's manual step.
- **Builder does NOT trigger the Vercel redeploy.** Gate (a) — even though pushing to `promethean-shell` already triggers an auto-deploy that picks up this commit, the bypass doesn't activate until the env var is set, and the verification deploy after the env var lands is Drake's call.
- **Builder does NOT verify the live bypass behavior on the deployed preview.** Gate (c) — eyeballing the live surface (in incognito, both with bypass active and on production with bypass NOT leaking) is the human-judgment task that stays with Drake.
- **Builder does NOT flip the spec status on main.** Per the spec, that's a downstream Director task.

## Side effects

**None outside the repo.** Specifically:

- No external API calls. No Slack posts, no email, no DB writes, no Anthropic / OpenAI calls.
- No env-var changes (Drake handles that in Vercel; Builder did NOT touch any `.env*` files).
- No `vercel.json` changes.
- No DB migrations.
- No `package.json` / `requirements.txt` changes.
- No effect on production. The conditional gates everything on an env var that is unset everywhere except the scoped Vercel slot Drake will configure.

Pushed two commits to `origin/promethean-shell`:

- `2eeb33a` — the bypass conditional in `app/(authenticated)/layout.tsx` + the known-issues entry.
- The report commit (this file) — pushed as the second commit.

Vercel will auto-deploy `promethean-shell` from the push. The new build will contain the bypass code but the bypass will NOT be active until Drake sets the env var.
