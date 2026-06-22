# Runbook: Vercel Python bundle size

What to do when a Vercel auto-deploy fails with `A Serverless Function has exceeded the uncompressed maximum size of 250 MB`.

## Symptoms

- Git-push to `main` triggers an auto-deploy that fails. Manual "Redeploy" from the Vercel dashboard sometimes works (cache jitter), sometimes doesn't.
- Build log ends with:
  ```
  Error: N functions exceeded the uncompressed maximum size of 250 MB.
  Learn More: https://vercel.link/serverless-function-size
  ```
- `vercel inspect --logs <failed-deployment-url>` shows per-function size breakdowns plus a top-10 "Large dependencies" list.

## Distinct from the 2026-05-08 cache-contamination signature

Same error message; different root cause. Decision tree:

- If the failed build log starts with `Restored build cache from previous deployment (<cache-id>)` AND the error fires during "Deploying outputs..." → likely **cache contamination** (2026-05-08 signature). Fix: dashboard Redeploy with **Use existing Build Cache** UNCHECKED. See `docs/fulfillment/known-issues.md` § Vercel build cache can carry forward bloated function bundles.
- If the failed build log shows `vercel inspect` per-function breakdown citing `.next/cache/`, `node_modules/`, or a heavy Python dep as the top contributor → **bundle size at the cap** (2026-05-11 signature). Fix: add or expand `excludeFiles` in `vercel.json`. This runbook.

Both signatures can coexist over time; check the build log to disambiguate.

## How to diagnose

### Get per-function bundle sizes

Vercel only emits size analysis on FAILED builds. For a current failure:

```bash
vercel ls --yes | head -5            # find the most recent failed deployment URL
vercel inspect --logs <URL>          # surfaces per-function size + top contributors
```

The `Large dependencies` section lists the top ~10 files / directories inside each oversized function.

### Identify what's contributing

Common offenders (from the 2026-05-11 diagnostic):

| Item | Size | Source | Excludable? |
|------|------|--------|-------------|
| `.next/cache/webpack` | ~130 MB | Next.js build creates this during Vercel's build, AFTER `.vercelignore` filters | Yes — `excludeFiles: ".next/**"` |
| `node_modules/@next/swc-linux-x64-gnu` | ~125 MB | Next.js production dep | Yes — `excludeFiles: "node_modules/**"` |
| `node_modules/next/dist` | ~80 MB | Next.js production | Yes |
| `node_modules/typescript/lib`, `lucide-react`, `lightningcss`, `ts-morph` | ~10-22 MB each | Next.js deps | Yes |
| `cryptography/hazmat/bindings` | ~13 MB | supabase → gotrue (JWT) | NO — actively used |
| `zstandard/.so` files | ~22 MB combined | supabase → storage3 → pyiceberg | Yes if you confirm storage path is unreachable |
| `pyroaring`, `hive_metastore`, `pyiceberg` | ~22 MB combined | Same chain | Yes, same caveat |
| `pydantic_core/.so` | ~4.5 MB | anthropic + openai + supabase | NO — actively used |

### Confirm the exclude target is unreachable

Before excluding a Python dep, verify no production code path reaches it. The `.next/`, `node_modules/`, `cache/`, build-artifact-style dirs are universally safe — Python has no business reading Next.js artifacts.

For Python deps: `grep -rn "import <module>\|from <module>" shared/ agents/ ingestion/ api/`. If zero hits, candidate. Be especially careful with lazy/dynamic imports (importlib, string imports) — they don't show up in grep.

## How to fix

### Step 1: edit vercel.json

Add `excludeFiles` to every Python function entry. The current working glob:

```json
"api/<function>.py": {
  "runtime": "@vercel/python@4.3.1",
  "maxDuration": 60,
  "excludeFiles": "{.next,node_modules}/**"
}
```

Notes:
- Brace expansion `{a,b}/**` is supported by Vercel's underlying `glob` matcher.
- `excludeFiles` is a single STRING, not an array. Multiple exclusions go inside one brace-expansion.
- Paths are relative to the function's bundle root (== project root for `@vercel/python`).
- The exclude applies AFTER Vercel's build creates the artifacts — that's what catches `.next/cache/webpack` and `node_modules/` which `.vercelignore` cannot reach.

### Step 2: validate via preview deploy

```bash
vercel deploy --yes
```

(Default deploys to preview, not prod.) If the deploy succeeds, every function is under 250 MB. If it still fails, the build log shows the updated size + remaining contributors — extend the glob and re-deploy.

The local `vercel build --prod` runs pip install but does NOT produce extractable Python function bundles locally; use `vercel deploy` (preview) for size validation rather than chasing the local build artifacts.

### Step 3: deploy to main

Once the preview deploy succeeds:

```bash
git add vercel.json
git commit -m "fix(vercel-python): excludeFiles to drop unused deps per function"
git push origin main
```

The production auto-deploy should succeed within ~2 minutes. Validate via:

```bash
vercel ls --yes | head -5
```

The most recent Production deployment should be `● Ready`.

### Step 4: validate intermittent failure is gone

Trigger 2-3 follow-on no-op commits to main (whitespace changes, doc tweaks, etc.) and confirm all 2-3 auto-deploys succeed in a row. This validates the failure isn't just hiding behind cache state.

## When to revisit

- **Adding a new Python function under `api/`.** Copy the existing `excludeFiles` glob to the new function entry in `vercel.json`. Skip this and the new function bundles `.next/` + `node_modules/` and breaks the deploy.
- **Adding a new heavy dependency to `requirements.txt`.** If the dep is >20 MB transitively, headroom shrinks. Re-measure via `vercel inspect --logs` on the next failed deploy (or compute the increase locally).
- **Upgrading the `@vercel/python` builder version.** The exclude semantics + bundling behavior may shift; re-validate via preview deploy after the bump.
- **The 250 MB error message appears again.** Decision tree above — check `vercel.json` for missing `excludeFiles` entries first.

## Historic narrative (why two entries exist in known-issues)

- **2026-05-08 — Vercel build cache contamination.** First 250 MB occurrence. Root cause: 55 untracked Python pkg directory skeletons at repo root (~37 MB) were uploaded by a local `vercel deploy` and seeded into the build cache; every subsequent git-push deploy restored the contaminated cache and overshot 250 MB. Fixed by deleting the skeletons + adding `data/` to `.vercelignore` + dashboard Redeploy with cache unchecked (uploaded a clean replacement cache).
- **2026-05-11 — Vercel build-artifact bundle bloat.** Second 250 MB occurrence. Root cause: `.next/cache/` and `node_modules/` are created by Vercel's build phase AFTER `.vercelignore` filters, and the `@vercel/python` builder bundles them into every Python function. With 9 Python functions × ~250 MB each, the project sat right at the cap; transitive-dep-version jitter tipped builds over intermittently. Fixed by per-function `excludeFiles` in `vercel.json`.

Both signatures produce the same error message. Build log + `vercel inspect --logs` is what disambiguates.
