# Ella curriculum retrieval regression — what's in the KB vs what she can reach (read-only)
**Slug:** ella-kb-retrieval-access-diagnostic
**Status:** shipped

**Target branch: ella-worktree**

> Specs live on `main` for Builder to read, but this one is being handed to Builder directly in the worktree (paste-to-Code workflow — avoids the mid-session branch-sync issue). Save it to `docs/specs/ella-kb-retrieval-access-diagnostic.md` in the worktree. Execution stays in the `ella-worktree` worktree at `~/projects/ai-enablement-ella`, NOT main. A Close-ingestion backfill is running on main in parallel — this work is Ella-only; do not touch anything Close-related.

## Why this exists

The Anthropic usage-cap incident (see `docs/reports/ella-haiku-badrequest-log-investigation.md`) is resolved — the cap was raised, Ella's Haiku calls succeed again, confirmed live: she now gives real, name-addressed, question-specific answers instead of the canned warm-opener fallback.

But the moment she came back online, a SECOND problem is now visible that the cap was masking. Every substantive curriculum question gets a "not in my KB" deflection:

- "what's covered in module 3?" → "I don't have curriculum module details in my KB — let me get Scott..."
- "whats covered in the sales module" → "I don't have the sales module curriculum details in my KB..."
- "whats the PACE framework" → "I don't have details on a PACE framework in the curriculum KB I can access..."

**Critical context from Drake: this curriculum content IS in the database — chunked and embedded — and Ella USED TO answer these questions.** So this is NOT a missing-content problem (the content exists) and NOT a "KB was never built" problem. It is a **retrieval regression**: something between Ella's query and the existing curriculum chunks changed so she can no longer reach content she previously could. Drake suspects her *access* to the content may have changed.

This is a **read-only diagnostic**. Find WHY the curriculum chunks aren't being retrieved. Do NOT fix it — the fix depends entirely on which of several candidate causes is true, and Director scopes the fix from confirmed findings.

## The hypotheses to distinguish

The content is confirmed present in `document_chunks`. So retrieval is excluding it at one of these stages. Determine which:

- **(A) `is_active` flag flipped.** Retrieval matches only chunks whose parent `documents.is_active = true` (per CLAUDE.md § retrieval contract + `shared/kb_query.py`). If the curriculum docs got flipped to `is_active = false` (by a migration, re-ingest, or cleanup), they're in the table but invisible to retrieval. **This is the leading hypothesis** — it exactly produces "the data's there but she can't reach it," and it's the kind of thing that changes as a side effect of other work.
- **(B) `source` / `document_type` scoping.** If the retrieval query filters on a `source` or `document_type` set that no longer includes the curriculum docs' values (or the docs' values changed), they're filtered out.
- **(C) Client-scoping mismatch.** Ella's retrieval runs through `shared.kb_query.search_for_client` against the channel-mapped client's scope. If curriculum content is general/global (not tagged to a specific client) and the query scopes to client-owned chunks only, general curriculum never matches. Check whether `search_for_client` applies a client filter that excludes global curriculum docs, and whether it USED to behave differently.
- **(D) Embedding model mismatch.** If the curriculum chunks were embedded with a different model than the live query embedding (the contract is OpenAI `text-embedding-3-small`, 1536 dims), similarity scores would be meaningless and nothing clears the threshold. Check the embedding dims / model on the curriculum chunks vs what the query path uses.
- **(E) Threshold / top-K too aggressive.** `ELLA_PASSIVE_KB_RELEVANCE_THRESHOLD` (default 0.3) or the retrieval top-K cutoff filters everything out. Less likely to be curriculum-specific, but cheap to check.

More than one may be true. Don't stop at the first.

## Acclimatization checklist

Read first, confirm in 4-5 bullets:

- `shared/kb_query.py` — the retrieval utility. Specifically `search_for_client` (the path Ella uses) and any `match_document_chunks` RPC call it makes. Note exactly what filters it applies: `is_active`, `source`, `document_type`, client-scoping, threshold, top-K.
- `agents/ella/passive_monitor.py` + `agents/ella/mention_classifier.py` — how Ella calls retrieval and with what client scope / query.
- `docs/schema/` — the `documents` and `document_chunks` table docs (purpose, columns, what `is_active` / `source` / `document_type` mean, what populates curriculum content).
- CLAUDE.md § Critical Rules — the `is_active` retrieval-safety contract and the metadata-validator contract, for context on how curriculum docs are supposed to be shaped.
- Confirm cloud read access via the pooler URL in `supabase/.temp/pooler-url` + `SUPABASE_DB_PASSWORD` from `.env.local` (quoted, contains `#`), via psycopg2 (psql not installed).

## What to do

All read-only. SELECTs against cloud Supabase + a controlled call of Ella's OWN retrieval path against the real DB to see what it returns. No writes, no fix, no flag flips, no re-ingest.

1. **Inventory the curriculum content in the DB.** Query `documents` for curriculum/course material — likely `source` values like `content` / `curriculum` / course-related, or `document_type` indicating lessons. Surface: how many curriculum docs exist, their `source` / `document_type` / `is_active` distribution, and a sample of titles. Confirm the content Drake says is there actually is — count and characterize it. Specifically surface the `is_active` true/false split on curriculum docs (hypothesis A).

2. **Inventory the curriculum CHUNKS.** Join to `document_chunks` — how many chunks exist for curriculum docs, and crucially the embedding dimensionality / any model indicator on them (hypothesis D). Confirm chunks exist and are embedded (non-null embedding).

3. **Reproduce Ella's actual retrieval for a known-failing query.** This is the deciding step. Using `shared/kb_query.py` exactly as Ella calls it (same function — `search_for_client` — same client scope she'd use for one of the channels where this failed, same threshold), run a query like "what is covered in module 3" or "PACE framework" against the REAL cloud DB. Capture: what chunks come back, their similarity scores, and — critically — whether curriculum chunks are absent from results or present-but-below-threshold. **This embeds a query and reads; it does not write.** Note it in Side effects (one or a few embedding API calls + DB reads).

4. **Bisect where curriculum drops out.** Based on step 3:
   - If curriculum chunks don't appear AT ALL → run the same vector search WITHOUT the `is_active` filter (read-only, a direct RPC/SQL variant) and see if they reappear. If they do → hypothesis (A) confirmed. If still absent → check the client-scoping filter (C): run unscoped vs client-scoped and compare.
   - If curriculum chunks appear but BELOW the threshold → hypotheses (D) embedding mismatch or (E) threshold. Check the embedding model/dims match; check what threshold is applied.
   - If a `source`/`document_type` filter is excluding them → hypothesis (B).
   The goal: name the exact filter or mismatch that removes curriculum chunks from Ella's results, with the before/after row counts as evidence.

5. **Confirm it's a regression, if cheaply possible.** Drake says she used to answer these. If there's a git-traceable change to `shared/kb_query.py` / `search_for_client` / the retrieval scoping, or a migration that flipped `is_active` on curriculum docs, or an env-var/threshold change — name it and its date. `git log` on the retrieval files + a check of recent migrations touching `documents.is_active` is in scope if quick. This tells us WHAT changed, which sharpens the fix. Don't rabbit-hole — if it's not quick, the current-state finding is enough.

## What success looks like

A report at `docs/reports/ella-kb-retrieval-access-diagnostic.md` stating, with evidence:

- **Curriculum content inventory** — how many docs/chunks exist, their `is_active` / `source` / `document_type` distribution, embedding dims. (Confirms Drake's "it's in there" and characterizes it.)
- **The deciding finding: which hypothesis (A–E, possibly multiple) explains why Ella can't retrieve it** — with before/after retrieval row counts as proof (e.g. "with is_active filter: 0 curriculum chunks; without it: 12 — hypothesis A confirmed").
- **What changed, if found** — the regression source (migration / code change / flag flip / env change) and date.
- **A "what the fix touches" pointer** (NOT the fix) — enough for Director to scope the fix spec immediately. Keep it tight.

## Hard stops

- **Read-only.** No writes to any cloud table, no flag flips (do NOT flip `is_active` back even if A is confirmed — that's the fix, and it's Director-scoped so we get the side effects right), no migration, no code change, no re-ingest. Step 3's retrieval reproduction (embedding a query + reading) is the only external call allowed.
- Operate in `ella-worktree`, not main.
- Do not touch anything Close-related — backfill running on main in parallel.
- If confirming hypothesis A, do NOT mass-flip curriculum docs back to active — note the count that would need flipping and leave it for the fix spec. (A blind mass-flip could re-activate docs that were deactivated deliberately; the fix needs Drake's eyes on what gets reactivated.)

## What could go wrong — think this through yourself

Seeds: curriculum docs might use a `source`/`document_type` you don't expect — inventory broadly before assuming a value. The "client scope" Ella uses for a general curriculum question is the subtle one — general curriculum may not be client-tagged at all, so a client-scoped search would never surface it even with everything else correct; check whether `search_for_client` was always client-scoped or whether global docs were previously included. If hypothesis A is true, check WHEN and HOW is_active got flipped — a deliberate deactivation (e.g. the call_review docs are intentionally `is_active=False` per the Call Review V1 ship) means the curriculum flip might be collateral from a script that over-matched. Don't conflate the intentionally-inactive call_review docs with the curriculum docs — they're different content with different correct `is_active` states. And: more than one hypothesis can be true at once; report all that fire.

## Mandatory doc updates

- Write the report to `docs/reports/ella-kb-retrieval-access-diagnostic.md`.
- Flip this spec's Status to shipped in the same commit that lands the report (read-only diagnostic, no gate).
- No other doc edits. If a known-issues entry is warranted, NAME it in the report's Out of scope / deferred for Director to spec — don't edit known-issues directly.
