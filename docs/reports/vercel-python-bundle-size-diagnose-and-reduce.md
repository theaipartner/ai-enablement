# Report: Vercel Python bundle size — diagnose + reduce per-function bundles
**Slug:** vercel-python-bundle-size-diagnose-and-reduce
**Spec:** docs/specs/vercel-python-bundle-size-diagnose-and-reduce.md

> DRAFT — Phase 1 findings landed first per the spec; Phase 2 + 3 + 4 will be appended as they complete.

## Phase 1 findings

**Limit is 250 MB.** Confirmed from the build log of the most recent failed production deploy (`ai-enablement-kjtd71foi`, 3m old at probe time, deployed 2026-05-11 ~05:38 UTC):

> `Error: 9 functions exceeded the uncompressed maximum size of 250 MB.`
> `Learn More: https://vercel.link/serverless-function-size`

Vercel's public docs cite "500 MB" for current Python runtime, but the actual limit applied to this project is 250 MB — likely a plan-tier cap rather than a docs-vs-runtime drift. Either way, **the empirical limit is 250 MB; the spec's ambiguity is resolved**.

**Per-function bundle sizes (from `vercel inspect --logs` against the failed deployment).** All 9 Python functions at **exactly 253.42 MB** — 3.42 MB over the cap, identical sizes because every function carries the same project-root + requirements.txt-installed-tree:

| Function | Size |
|----------|------|
| `/api/fathom_backfill` | 253.42 MB |
| `/api/fathom_events` | 253.42 MB |
| `/api/slack_events` | 253.42 MB |
| `/api/gregory_brain_cron` | 253.42 MB |
| `/api/airtable_nps_webhook` | 253.42 MB |
| `/api/accountability_roster` | 253.42 MB |
| `/api/airtable_onboarding_webhook` | 253.42 MB |
| `/api/accountability_notification_cron` | 253.42 MB |
| `/api/passive_ella_cron` | 253.42 MB (added Batch 2.3, 2026-05-11) |

The Next.js front-end functions (`/clients`, `/calls`, `/ella/runs`, etc.) are all ~3.25 MB — under the limit easily.

**Top contributors per function (identical list across all 9):**

| Item | Size | Notes |
|------|------|-------|
| `.next/cache/webpack` | **129.73 MB** | ~52% of the bundle. Next.js webpack cache. Created during Vercel's build phase AFTER `.vercelignore` exclusions apply, so the existing `.next/` ignore line doesn't reach it. Unreachable from any Python import graph. |
| `cryptography/hazmat/bindings` | 13.28 MB | Legitimate — supabase → gotrue → cryptography (JWT verification). |
| `zstandard/_cffi.cpython-312-x86_64-linux-gnu.so` | 11.58 MB | Dead — supabase → storage3 → pyiceberg → zstandard. We never call storage. |
| `zstandard/backend_c.cpython-312-x86_64-linux-gnu.so` | 11.02 MB | Dead — same chain. |
| `pyroaring.cpython-312-x86_64-linux-gnu.so` | 7.59 MB | Dead — pyiceberg → pyroaring. |
| `.vercel/builders/node_modules` | 6.37 MB | Build infrastructure. Probably can't safely exclude. |
| `pydantic_core/_pydantic_core.cpython-312-x86_64-linux-gnu.so` | 4.53 MB | Legitimate — anthropic, openai, supabase all use pydantic. |
| `pygments/lexers/__pycache__` | 3.15 MB | Transitive via supabase/rich for traceback rendering. Could exclude. |
| `hive_metastore/__pycache__/ThriftHiveMetastore.cpython-312.pyc` | 2.75 MB | Dead — pyiceberg module. |
| `hive_metastore/ThriftHiveMetastore.py` | 2.14 MB | Dead — pyiceberg module. |

**The mystery deps explained.** `pyiceberg / hive_metastore / pyroaring / zstandard` aren't in our `requirements.txt`. Chain: `supabase >= 2.9` → `storage3 >= 0.10` (transitive) → `pyiceberg >= 0.7` (storage3 added Iceberg-table-format support in late 2025) → `pyroaring + zstandard`. The `hive_metastore` package is bundled inside `pyiceberg`. Total dead-code weight from this chain: **~25 MB**. We never call any `supabase.storage` API; `storage3` is imported eagerly by `supabase.client` at module-load but its dependencies are only lazy-loaded if you actually use the Iceberg table API. So a per-function exclusion of `pyiceberg/`, `hive_metastore/`, `pyroaring*`, and `zstandard/` is safe in principle — but the dominant fix doesn't require touching them.

**Headroom math:**

| Scenario | Bundle size | Margin under 250 MB |
|----------|-------------|---------------------|
| Today (no fix) | 253.42 MB | **OVER by 3.42 MB** |
| Fix A1: exclude `.next/**` only | ~123.7 MB | 126.3 MB |
| Fix A2: also exclude pyiceberg subtree | ~98 MB | 152 MB |

Even Fix A1 alone gives 126 MB of headroom — more than 50% of the limit — comfortable against transitive-dep-version jitter. **Recommendation: ship A1 (`.next/**` exclusion only) as the minimum viable fix.** Defer A2 unless future bundle growth eats into A1's headroom; A2 carries the small additional risk of "what if supabase ever calls into the iceberg path on a code path we don't expect."

**Cross-reference: imports per function.** All 9 Python functions import `from shared.db import get_client` → `from supabase import Client, create_client` → eager `storage3` chain → eager `pyiceberg` chain (though not lazy-iceberg-table calls). None of them touch `.next/` (Python has no business reading the Next.js webpack cache). So `.next/**` is a universally safe exclude across every function.

A function-level exclusion split could shave more (e.g., `airtable_nps_webhook.py` never reaches the Anthropic SDK, so could exclude `anthropic/`, `tokenizers/`, `jiter/`), but that's premature optimization given the 126 MB headroom A1 produces. Documented as a future option in the runbook.

## Decision: Fix shape

**Shape A1.** Add `excludeFiles: ".next/**"` to every Python function entry in `vercel.json`. No transitive pins, no project split, no per-function dep tuning. Spec § Phase 2 Shape A — simplest viable fix; matches what the measurement shows is needed and no more.

## Phase 2 — fix applied

(To be filled in once vercel.json is updated and the local build confirms.)

## Phase 3 — validation

(To be filled in post-deploy.)

## Phase 4 — docs

(To be filled in once docs land.)

---

Will rewrite the standard six-section report shape below once Phases 2-4 land.
