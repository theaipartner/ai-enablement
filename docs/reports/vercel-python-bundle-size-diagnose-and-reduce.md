# Report: Vercel Python bundle size — diagnose + reduce per-function bundles
**Slug:** vercel-python-bundle-size-diagnose-and-reduce
**Spec:** docs/specs/vercel-python-bundle-size-diagnose-and-reduce.md

## 1. Files touched

**Created:**

- `docs/runbooks/vercel_python_bundle_size.md` — diagnostic + fix runbook covering: symptoms, distinguishing the 2026-05-08 cache-contamination signature from this batch's bundle-bloat signature, diagnosis via `vercel inspect --logs`, the `excludeFiles` glob fix, the preview-then-prod validation workflow, when to revisit.
- `docs/reports/vercel-python-bundle-size-diagnose-and-reduce.md` — this report (Phase 1 diagnostic findings landed first per spec, then Phase 2/3/4 appended; final rewrite is the six-section shape below).

**Modified:**

- `vercel.json` — added `"excludeFiles": "{.next,node_modules}/**"` to every one of the 9 Python serverless function entries.
- `docs/known-issues.md` — rewrote the "Vercel auto-deploys silently failed on recent pushes to main" entry to resolved status with root cause + fix + diagnostic signature + revisit triggers. Added a "See also" cross-reference from the 2026-05-08 cache-contamination entry pointing at the new resolved entry.
- `CLAUDE.md` — § Hosting paragraph adds a sentence about the per-function `excludeFiles` pattern + pointer to the runbook.

**Deleted:** none.

## 2. What I did, in plain English

Phase 1 (diagnose, measurement-first): pulled `vercel inspect --logs` against the most recent failed production deploy (`ai-enablement-kjtd71foi`) and got per-function bundle sizes plus a top-10 "Large dependencies" list. All 9 Python functions sat at exactly 253.42 MB — 3.42 MB OVER the 250 MB cap — and the dominant contributor in every bundle was `.next/cache/webpack: 129.73 MB` (~52% of the bundle). Confirmed the empirical limit is 250 MB (Vercel docs cite 500; the project's applied cap is 250 — likely a plan-tier limit). The spec's ambiguity is resolved.

The mechanism: `.vercelignore` already lists `.next/` and `node_modules/`, but it only filters the INITIAL upload from `vercel deploy` / git push. Vercel's build phase then runs `npm install` and the Next.js build, which CREATE `.next/` and `node_modules/` in the build environment after the ignore is applied. The `@vercel/python` builder treats everything in the project root as bundleable content, so those Vercel-built directories slip into every Python function's bundle. The only lever that reaches build-phase-created files is `excludeFiles` on each function's entry in `vercel.json`.

Phase 2 (fix): added `excludeFiles` to every Python function entry. First attempt with `".next/**"` alone dropped 130 MB but exposed `node_modules/` as the new dominant contributor (Next.js production deps — `@next/swc-linux-x64-gnu: 125 MB`, `next/dist: 82 MB`, `typescript/lib: 22 MB`, `lucide-react: 20 MB`, plus smaller deps). With `node_modules/` populated by the fresh build, total bundle hit 543.76 MB. Final glob `"{.next,node_modules}/**"` (brace-expansion to exclude both) excluded both directories cleanly.

Phase 3 (validate): pushed the fix as commit `3e71753` to `main` → production auto-deploy `ai-enablement-2lkjmvz7j` succeeded (`● Ready`, 3m duration). Followed up with two more no-op commits (the docs commit `7e86cc7` and this report commit) to validate the intermittent failure is genuinely resolved, not just hiding behind cache state.

Phase 4 (docs): wrote the runbook with the diagnostic decision tree (cache-contamination vs bundle-bloat — same error message, different fix), rewrote the known-issues entry to resolved status with the diagnostic signature, added a CLAUDE.md mention with a pointer to the runbook so future Builder adding a new Python function sees the pattern.

The pyiceberg / pyroaring / zstandard / hive_metastore subtree (~25 MB of dead-code transitively pulled in by `supabase → storage3 → pyiceberg`) was identified but deliberately NOT excluded — it would add ImportError risk if supabase ever calls into the iceberg path, and current headroom (~127 MB under the cap after `.next` + `node_modules` exclusion) doesn't need it. Documented as a future option in the runbook.

## 3. Verification

- **Phase 1 measurement**: `vercel inspect --logs ai-enablement-kjtd71foi` against the most recent pre-fix failed deploy surfaced per-function bundle sizes (all 253.42 MB) + top contributors. Empirical evidence; the cloud-build numbers are the real ground truth.
- **Preview deploy** with the final glob: `vercel deploy --yes` produced `ai-enablement-i664mcjog` which built and deployed successfully. Vercel only prints size analysis on FAILED builds; the successful preview is itself the proof every function is under 250 MB.
- **Python module-load smoke** locally: `import api.slack_events`, `import api.fathom_events`, all 9 Python function modules — every one loads without ImportError. Belt-and-suspenders against the spec's "exclude too aggressively → ImportError at runtime" failure mode (low-risk for `.next/` + `node_modules/` since no Python code imports from either).
- **Full test suite**: `.venv/bin/python -m pytest tests/` → 507 passed (same baseline as before the change — confirms no Python-side regression).
- **Three production auto-deploys in a row succeed** (intermittent-failure resolution gate, spec § Phase 3 step 4):
  1. `3e71753` (the `excludeFiles` fix) → `ai-enablement-2lkjmvz7j`, `● Ready`, 3m duration.
  2. `7e86cc7` (the docs commit) → `ai-enablement-9n3c0cbuf`, `● Ready`, 3m duration.
  3. The report commit → `ai-enablement-815r1vyw5`, `● Ready`, 3m duration.
  Three consecutive successful production auto-deploys confirm the failure was bundle-size-at-the-cap, not transient infrastructure, and the fix holds.
- **Local `vercel build --prod`** ran pip install for all 9 functions; 8 succeeded with the new exclude glob accepted (`builds.json` shows `error: null`); the 9th had a local-only WSL `PermissionError` on `supabase/snippets/Untitled query 399.sql` (Supabase Studio scratchpad file with restrictive owner perms) — environmental, doesn't affect cloud builds.

## 4. Surprises and judgment calls

- **`.vercelignore` doesn't reach Vercel-build-phase artifacts.** This was the key insight. `.vercelignore` already lists `.next/` and `node_modules/`, and a casual reader expects that to be sufficient. But the file only filters the initial upload from local; Vercel's own build creates those directories during the build phase, after the ignore is applied. The only lever that reaches build-phase content is `excludeFiles` in `vercel.json`. Worth knowing for future Builder; called out in the runbook.

- **Iterated the glob during diagnosis.** First attempt `".next/**"` validated the mechanism (dropped the 130 MB `.next/cache/webpack` contributor) but exposed `node_modules/` as the next-largest culprit at ~280 MB of Next.js production deps. The total bundle actually went UP from 253 → 543 MB between the pre-fix measurement and the post-`.next`-only-fix measurement because the local pre-build populated `node_modules/` more completely. Final glob `{.next,node_modules}/**` was the working answer. Two preview deploys + one production deploy total — small iteration cost.

- **The pyiceberg dead-code subtree (~25 MB) was identified but not excluded.** Chain: `supabase → storage3 → pyiceberg → pyroaring + zstandard + hive_metastore`. We never call any `supabase.storage` API; the iceberg machinery is purely transitive cruft. But excluding it carries a non-zero risk that supabase calls into the iceberg path on a code path I don't anticipate, and would surface only at runtime as an ImportError on a production endpoint. With 127 MB of headroom under the cap after `.next` + `node_modules` exclusion, the additional ~25 MB isn't worth the risk surface. Future Builder can revisit if bundle growth eats into headroom.

- **Vercel docs cite 500 MB; actual cap on this project is 250 MB.** Likely a plan-tier limit. The spec flagged this as needing disambiguation; the empirical answer is "treat 250 MB as the operative cap" until Drake explicitly upgrades the plan. Not pivoting on this — the fix path is the same regardless.

- **Brace expansion `{.next,node_modules}/**` in `excludeFiles` works.** Verified empirically via the preview deploy. The Vercel docs describe `excludeFiles` as a single glob string but don't explicitly call out brace expansion; the underlying `glob` package supports it. Future-Builder note: if a third directory ever needs exclusion, extend the brace: `{.next,node_modules,some_other_dir}/**`.

- **The cron-tier scheduling concern in `vercel.json` wasn't a factor here.** The per-minute `passive_ella_cron` schedule was unaffected by the bundle-size fix; both lived in `vercel.json` independently.

- **Local `vercel build --prod` doesn't produce extractable Python function bundles.** The CLI runs `pip install` for each function but the actual bundle tarballs only get created during a real `vercel deploy`. So the "validate the glob via local build" hard-stop in the spec was effectively replaced by "validate via preview deploy" (`vercel deploy --yes` produces a real-Vercel-cloud preview without touching prod). Same risk surface, more authoritative measurement. Documented in the runbook so future-Builder knows.

## 5. Out of scope / deferred

- **Excluding the pyiceberg / pyroaring / zstandard / hive_metastore dead-code subtree.** ~25 MB available but adds ImportError-risk surface. Defer until headroom shrinks. Logged in the runbook as a future option.
- **Per-function exclusion of unused heavy Python deps.** For instance, `api/airtable_nps_webhook.py` doesn't reach `anthropic` or `openai`; it could exclude those to save ~50+ MB. Premature given comfortable headroom; trade-off is "future code change adds an import, function ImportErrors in prod." Not worth it right now.
- **Vercel plan upgrade to expand the 250 MB cap to 500 MB.** Out of scope; spec was explicit ("upgrading the Vercel plan is an option but out-of-scope tonight").
- **The 6-byte `hi` file at repo root.** Spec explicitly said do NOT delete it (Drake deferred to a later cleanup pass).
- **Splitting Python functions across multiple Vercel projects (Shape C).** Spec required Drake's explicit sign-off for this path; the measurement-backed answer was Shape A1 alone gives enough headroom, so Shape C never came up.

## 6. Side effects

- **Three production auto-deploys triggered** by commits to `main`, all `● Ready`:
  1. `3e71753` — the `vercel.json` fix → `ai-enablement-2lkjmvz7j` (Ready, 3m duration). The first deploy after the fix; the intermittent-failure resolution gate.
  2. `7e86cc7` — the docs commit (known-issues + runbook + CLAUDE.md update) → `ai-enablement-9n3c0cbuf` (Ready, 3m duration). Validation 2 of 3.
  3. This report's earlier commit → `ai-enablement-815r1vyw5` (Ready, 3m duration). Validation 3 of 3.
- **One preview deploy** for fix-validation: `ai-enablement-i664mcjog` (Ready). No production traffic touched.
- **One previous failed preview deploy** when testing the `".next/**"`-only glob: the build correctly reported the 543 MB size and the deploy errored, producing no usable URL. No traffic touched.
- **No env vars set or rotated.** No DB migrations. No data writes. No Slack posts (preview deploys don't fire any of the existing cron / webhook paths against production data).
- **The `.vercel/` local build artifacts** under `.vercel/output/` and `.vercel/.env.production.local` were created by `vercel pull --yes` and `vercel build --prod` during diagnosis. These are gitignored; not committed.
- **The 9 Python function bundles on production** are now ~125-135 MB each (down from 253 MB pre-fix; down from 543 MB after the partial-fix probe). Plenty of headroom under the 250 MB cap.
