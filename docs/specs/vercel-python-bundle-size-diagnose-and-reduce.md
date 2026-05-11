# Vercel Python bundle size — diagnose + reduce per-function bundles
**Slug:** vercel-python-bundle-size-diagnose-and-reduce
**Status:** in-flight

## Context

Git-push deploys to `main` intermittently fail with the literal error message `A Serverless Function has exceeded the unzipped maximum size of 250 MB`. Manual Redeploy from the Vercel dashboard (with or without "Use existing Build Cache") consistently resolves it. Observed pattern over the last 24h: 3 queued auto-deploys all failed; manual Redeploy succeeded.

This is the second recurrence of the 250 MB error. The first occurrence (2026-04-29 to 2026-05-08, M3.3-era) was root-caused to 55 untracked Python pkg directory skeletons uploaded via `vercel deploy` from local, contaminating the build cache. The Phase 3b fix on 2026-05-08 deleted those skeletons + added `data/` to `.vercelignore` + ran a no-cache Redeploy that uploaded a clean cache. The fix held for ~3 days; symptom is back.

**Repo-root audit ruled out the May 8 signature.** Director confirmed via GitHub MCP (`get_file_contents` against `main` root) that there are no Python pkg skeletons currently committed. `.vercelignore` already excludes `.venv/`, `venv/`, `__pycache__/`, `tests/`, `data/`, `.next/`, `node_modules/`. Only oddity is a 6-byte file `hi` at repo root — too small to matter for 250 MB, deferred as housekeeping for a future cleanup.

**Working hypothesis (Director's analysis, needs Builder to confirm with measurement, NOT speculation):** the codebase added a 9th Python function (`api/passive_ella_cron.py`) on 2026-05-11 with Batch 2.3. `vercel.json` now lists 9 `@vercel/python@4.3.1` functions, each of which gets its own bundle. Every bundle pulls in the full project-root `requirements.txt` dep tree (`anthropic>=0.68`, `openai>=1.58`, `supabase>=2.9`, `python-dotenv>=1.0`) plus everything reachable via the `shared/`, `agents/`, `ingestion/`, `api/` import graph. With heavy deps like `anthropic` (pulls tokenizers/pydantic-core), `openai` (pulls tiktoken/pydantic-core), and `supabase` (pulls postgrest/gotrue/realtime/storage3) all in every bundle, the per-function bundle sits close to or over 250 MB. The instability is consistent with "bundle is right around the limit; cache-miss rebuilds resolve to slightly different transitive versions and occasionally tip over."

**Two important corrections Director surfaced via web search that affect scope:**

1. **Per-function `requirements.txt` is NOT a feature of `@vercel/python`.** The Vercel docs only describe a single project-root `requirements.txt`. Earlier framing of "per-function `requirements.txt` is what Vercel recommends" was wrong. The actual lever is `excludeFiles` in `vercel.json` under each function entry — a glob pattern that excludes files from that specific function's bundle. See https://vercel.com/docs/functions/runtimes/python under "Controlling what gets bundled."

2. **The current Vercel Python docs say "maximum uncompressed bundle size of 500 MB"** but the error we keep hitting says 250 MB. This delta needs Builder to confirm during diagnosis. Possibilities: (a) docs reflect newer limit + we're on an older runtime that's still on 250 MB, (b) the limit varies by Vercel plan tier, (c) the error message itself is misleading us. Either way, knowing whether our cap is 250 or 500 MB changes the urgency of fixes.

**Diagnostic gap that blocks targeted fixes.** A previous attempt to use `VERCEL_ANALYZE_BUILD_OUTPUT=1` env var did not produce per-function bundle-size breakdowns in the build log (build log only shows `Analyzing 18 functions...` then proceeds to "Deploying outputs..." with no breakdown). Drake doesn't have time to keep iterating on dashboard-side investigation. Builder has Vercel CLI access and can run measurements directly against a local build or via `vercel inspect` against a deployment.

## Acclimatization checklist — confirm before starting

1. **Read `vercel.json`** at repo root. Note the 9 functions listed under `functions` and 4 crons. Note the `@vercel/python@4.3.1` builder version on every function.
2. **Read `requirements.txt`** at repo root. Note the 4 declared deps + their version constraints.
3. **Read `.vercelignore`** at repo root. Note that `tests/`, `.venv/`, `data/`, etc. are already excluded.
4. **Trace at least 3 representative function import graphs** — `api/airtable_nps_webhook.py` (Director already read; imports only `shared.db` + supabase, no Anthropic/OpenAI), `api/slack_events.py` (Ella reactive path; imports `agents/ella/agent.py` → `shared/claude_client.py` → `anthropic`), `api/passive_ella_cron.py` (Ella passive path; imports both `anthropic` via the Sonnet generation path AND `anthropic` via the Haiku decision). Confirm Director's understanding that the import graphs vary substantially across functions.
5. **Read `docs/known-issues.md` § ~~Vercel build cache can carry forward bloated function bundles~~** — the 2026-05-08 resolution narrative. Confirm the current signature is different (no untracked pkg skeletons; cache contamination ruled out).
6. **Confirm Vercel CLI is available locally and authenticated to the project.** `vercel whoami` + `vercel link --project ai-enablement` (or whatever the project is named). If not authenticated, Builder either uses Drake's locally-cached creds or stops and surfaces.

## Goal

Reduce the per-function Python bundle size below the actual Vercel limit (250 or 500 MB — confirm which) by a margin large enough that transitive-dep-version jitter doesn't tip any function over. Restore reliable git-push auto-deploys.

This is BOTH a diagnosis spec AND a fix spec. Builder runs measurements first, then ships the appropriate fix based on what the measurements show. Don't ship a fix without measurement-backed evidence of what's bloating which function.

## What success looks like

### Phase 1: Diagnose (measurement, no code changes)

Run these in order. Stop and surface to Drake/Director if anything is surprising before proceeding to Phase 2.

**Step 1: confirm the real bundle size limit.**

Two sub-checks:

(a) Run `vercel inspect --logs <recent-deployment-url>` against a recent successful deployment (commit `e4706af` deployed at 2026-05-11 ~01:34 UTC is a known-good no-cache redeploy). Look for any text mentioning 250 MB vs 500 MB. The `vercel inspect` output should include the actual limit applied.

(b) Examine the failed-deploy build logs for the exact error text. Drake has seen `A Serverless Function has exceeded the unzipped maximum size of 250 MB. To view a detailed report, set VERCEL_ANALYZE_BUILD_OUTPUT=1 in your environment variables and redeploy.` Confirm the 250 number is in the message text and not a misread.

If the limit is 500 MB and we're hitting 250: there's a non-bundle-size cause and the spec pivots. Stop and surface.

**Step 2: measure each function's bundle size empirically.**

Two viable paths:

(a) **Local `vercel build` + size measurement.** Run `vercel build --prod` locally (this invokes the same builder Vercel runs in CI). Output lands in `.vercel/output/functions/`. Each function's bundle is a directory under there; `du -sh .vercel/output/functions/api/*` gives per-function sizes. This is the cleanest measurement — same builder, same dep resolution, same exclusion rules.

(b) **Inspect a recent deployment via `vercel inspect`.** May or may not surface per-function sizes depending on Vercel's tooling at the time Builder reads this.

Try (a) first. If the local build fails for environmental reasons (Python version mismatch, missing system deps, etc.), fall back to (b). If both fail, surface to Drake — this is the spec's measurement gate and we can't fix what we can't measure.

**Step 3: for the largest function(s), identify the top contributors.**

`du -sh .vercel/output/functions/api/<function-name>/python/lib/python3.12/site-packages/*/ | sort -h | tail -20` (path approximate; Builder figures out exact path from the local build output). This produces a sorted list of installed-package sizes. Look for outliers: tiktoken (typically ~120 MB), tokenizers (~50 MB), pydantic-core (~30 MB), grpc/protobuf (varies), pandas (~50 MB if pulled in transitively).

**Step 4: cross-reference each function's actual imports against the installed packages.**

For each function in `vercel.json`, trace the import graph (Builder may use `grep -r "^import\|^from " api/<function>.py shared/ agents/ ingestion/` plus follow `__init__.py` files OR use a Python AST tool). For each installed package in the function's bundle, ask: is this actually reachable from this function's import graph? If not, it's a candidate for exclusion.

The expected outcome of Phase 1: Builder writes a short diagnostic finding into the report draft (saved to `docs/reports/vercel-python-bundle-size-diagnose-and-reduce.md` even before Phase 2 starts), structured as:

- Largest function: `<name>` at `<size>` MB
- Top 3 contributors to that bundle: `<pkg1> <size>`, `<pkg2> <size>`, `<pkg3> <size>`
- Smallest function: `<name>` at `<size>` MB
- Mean function bundle size: `<size>` MB
- Headroom (limit minus largest): `<size>` MB
- Per-function actually-imported package list (rough — top-level imports are enough)

### Phase 2: Fix

The fix shape depends on Phase 1 findings. The three plausible shapes, in increasing-complexity order:

**Fix shape A: `excludeFiles` in `vercel.json` to trim known-unused dep dirs per function.**

If Phase 1 confirms specific functions don't import specific heavy deps (e.g., `api/airtable_nps_webhook.py` doesn't transitively import `anthropic`), add `excludeFiles` globs to those functions' entries in `vercel.json`. Example:

```json
"api/airtable_nps_webhook.py": {
  "runtime": "@vercel/python@4.3.1",
  "maxDuration": 60,
  "excludeFiles": "{anthropic,tokenizers,jiter}/**"
}
```

The exclude path syntax is relative to the function's bundle root. Builder confirms exact glob syntax by reading https://vercel.com/docs/functions/runtimes/python or by trial. **Test each exclusion locally via `vercel build` before pushing** — exclude too aggressively and the function fails at runtime with ImportError; exclude too lightly and bundle stays over limit.

Risk: if a future change adds an import that requires the excluded dep, the function fails at runtime, not build time. Acceptance: in exchange for fitting under the bundle limit, we accept "must update vercel.json excludeFiles when adding imports to a Python function." Document this in a new known-issue entry + add a paragraph to CLAUDE.md.

**Fix shape B: pin transitive versions in `requirements.txt` to stop bundle-size jitter.**

If Phase 1 shows the bundles are right around the limit with no specific outlier package, the issue is transitive resolution variability. Pin the heavy transitive deps explicitly in `requirements.txt` so every build resolves identically. Builder identifies the heavy transitives via the Phase 1 site-packages listing, adds them to `requirements.txt` with `==<observed-version>` pins. Doesn't reduce bundle size but eliminates the "intermittent" part of the failure.

This is a stopgap, not a real fix. Use only if Shape A doesn't get us enough headroom OR if Drake explicitly wants the minimal-change path tonight.

**Fix shape C: split functions into separate Vercel projects.**

If Phase 1 shows we genuinely need anthropic+openai+supabase in every function AND the limit is 250 MB AND bundle size can't be brought down via exclusion, the right architectural fix is splitting the Python functions across multiple Vercel projects so each project has fewer functions to bundle. This is significantly more work (multiple project configs, env var duplication, GitHub Actions or similar for coordinated deploys, possibly DNS routing).

**Do NOT propose this without explicit Drake sign-off.** If Phase 1 points here, stop and surface — let Drake decide whether the scope is acceptable tonight or if we want a tactical Shape A/B for now and Shape C as a future spec.

### Phase 3: Validate the fix

After applying Shape A or B:

1. Run `vercel build --prod` locally; confirm each function's bundle is under the limit with margin.
2. Push the fix to a feature branch (NOT main); let Vercel auto-deploy the preview. Confirm the preview build succeeds.
3. Merge to main; confirm the production auto-deploy succeeds. NOT a manual Redeploy — a real git-push.
4. Trigger 2-3 more no-op commits to main (e.g., whitespace changes to CLAUDE.md, or piggy-back on the next real commit) and confirm all 2-3 auto-deploys succeed in a row. This validates the intermittent failure is actually resolved, not just hiding.

If step 4 shows any of the 2-3 deploys fail: the fix didn't fully resolve the issue. Capture the build log signature of the failed deploy and surface to Drake.

### Phase 4: Document

Mandatory doc updates:

- **`docs/known-issues.md` § "Vercel auto-deploys silently failed on recent pushes to main (intermittent)"** — rewrite this entry. Current state says "Next time this recurs, check the Vercel dashboard." Replace with the actual root cause + fix Builder applied + a new "revisit trigger" (when adding new Python functions OR new heavy deps OR upgrading `@vercel/python` builder version).

- **`docs/known-issues.md` § "Vercel build cache can carry forward bloated function bundles..."** — add a cross-reference at the end of this entry pointing to the new entry (or the rewritten version of the entry above). Future-future-Director should see both contamination AND bundle-size issues as related-but-distinct.

- **`CLAUDE.md` § Hosting** — if the fix changes how Python functions are configured (excludeFiles, or otherwise), update the Hosting paragraph to mention "Python functions use per-function `excludeFiles` in `vercel.json` to keep bundle size under Vercel's limit." Brief; pointer to the runbook below.

- **New `docs/runbooks/vercel_python_bundle_size.md`** — diagnostic + fix runbook. Sections: (a) symptoms (250 MB error in build log, intermittent push-driven deploy failures), (b) how to diagnose (vercel build --prod local + du -sh, OR vercel inspect), (c) how to fix (excludeFiles syntax + examples), (d) when revisit (adding new Python function, new heavy dep, builder version upgrade), (e) the historic narrative (May 8 was contamination; May 11 was bundle-size; both produced the same error message via different root causes). Drake reads this when the symptom next recurs.

- **`vercel.json`** — the fix itself, if Shape A or B applies.

- **`requirements.txt`** — if Shape B applies (transitive pins).

## Hard stops

- **No fix without measurement.** Phase 1 must produce empirical per-function bundle sizes before Phase 2 starts. If measurement can't be obtained for any reason, stop and surface — don't ship speculative fixes.
- **No Shape C without Drake sign-off.** Splitting projects is architecturally significant and out-of-scope tonight unless Drake explicitly approves.
- **No excludeFiles globs without local-build verification.** Test every glob via `vercel build --prod` before pushing. A wrong glob looks like it worked at build time and ImportErrors in production.
- **No production deploy until Phase 3 step 1 (local build) confirms the fix works.** Don't push fix code that hasn't been built locally first.
- **The 6-byte `hi` file at repo root.** Drake explicitly deferred deletion ("we can bundle that with other work"). Do NOT delete it as part of this spec.
- **Batch 2.3 functionality (Ella passive monitoring) must keep working.** The `api/passive_ella_cron.py` cron is per-minute and live. Don't break its imports with overly aggressive `excludeFiles`. If the cron is the function with the worst bundle, Builder may need to think hard about which deps it actually transitively requires (probably anthropic for both Haiku + Sonnet, supabase for DB, NOT openai). Test passively-monitored functionality survives the fix.

## What could go wrong

- **Local `vercel build` produces a different bundle size than the cloud build.** Possible if Python version mismatches or system library availability differs. Mitigation: Builder runs the local build in Docker matching Vercel's Python 3.12 image OR runs against a fresh venv with the exact `requirements.txt` pins, then accepts a ~10% discrepancy as the local-vs-cloud delta.
- **`excludeFiles` glob excludes a file the function actually imports lazily (via importlib, or via a string-typed import).** Detected only at runtime. Mitigation: after applying the fix, hit each affected function's endpoint (or its smoke-test surface) once and confirm it doesn't ImportError. For the Ella passive cron, this means waiting for the next minute-cron tick and watching `/ella/runs` for an error row.
- **The 250 MB vs 500 MB question turns out to be "your plan is 250 MB."** If so, upgrading the Vercel plan is an option but out-of-scope tonight. Stop and surface; the fix path is unchanged.
- **The fix works but Vercel's build cache keeps the old (broken) state.** Mitigation: after the fix lands, do one manual Redeploy with "Use existing Build Cache" UNCHECKED to seed a clean cache. Then test the auto-deploy behavior.

## Commit shape

Builder picks. Likely:

1. `diagnose: capture per-function bundle sizes via local vercel build` (no code change, just the measurement output appended to the in-flight report)
2. `fix(vercel-python): excludeFiles per function to drop unused deps` — vercel.json changes
3. `docs: known-issues + runbook + CLAUDE.md for vercel python bundle fix`
4. Final report commit.

Report at `docs/reports/vercel-python-bundle-size-diagnose-and-reduce.md` per the spec/report convention. **The report should explicitly include the Phase 1 measurements**, even if the fix is small, so future-Director has the actual sizes for reference when this recurs.

## One ambiguity Builder needs to resolve

The Vercel docs say "maximum uncompressed bundle size of 500 MB" but the error message says 250 MB. Builder confirms which is real BEFORE choosing fix shape. Methods:

1. `vercel inspect` against a recent successful deployment — does it cite a limit?
2. Web-search "vercel python function 500 MB 250 MB" for the current state of the limit
3. Read the actual Vercel dashboard project settings for any bundle-size cap configuration

If the limit is genuinely 500 MB and we're hitting 250 MB ceiling for some other reason (per-function cap vs total project cap? region-specific?), the fix is different and Builder pivots. Surface to Drake before changing approach.
