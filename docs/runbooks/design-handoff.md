# Runbook: Design hand-off — Drake → Director → Design → Builder

How visual work gets done end-to-end on this repo: who does what, in what order, and where the artifacts land. Used on the Gregory Calls + Clients redesigns (2026-05-13); now the default for any work that's primarily visual.

## When to use this workflow

- **Use it for visual work.** Page redesigns, new UI surfaces, layout changes where design judgment matters more than code execution.
- **Don't use it for pure data-layer work** (server actions, RPC additions, data layer extensions, classifier tuning). Spec → Builder is faster and Design has nothing to offer.
- **Don't use it for small CSS fixes or text-only changes.** Edit-in-place via a quick Builder spec — design doesn't earn the round-trip cost.

If the work has both visual + data-layer components (the typical redesign — new column needs new data plumbing), the data-layer half can ship as a pre-design spec while the design workflow runs in parallel; the UI spec then references both the mock and the already-shipped data fields. This pattern is what shipped the Calls redesign cleanly (`docs/specs/gregory-redesign-part-2-calls-data-layer.md` shipped the data layer first; the UI spec consumed it).

## The four-stage flow

1. **Drake + Director ideate in chat.** Drake brings the problem; Director asks the questions that pin down scope, constraints, the columns / sections / pills that need to exist. The output is a shared mental model — not a written artifact yet.

2. **Director writes a Design-facing prompt.** Director writes a prompt that Drake will hand to Claude Design. The prompt is the bridge: it tells Design what to design + what visual vocabulary already exists in the repo. Required content:
   - Which surface(s) to design (e.g. "/clients list + /clients/[id] detail").
   - The data fields the design can assume (read `lib/db/<surface>.ts` and enumerate the row / detail shape — names, types, nullability).
   - The primitives that already exist (`components/gregory/header-band.tsx`, `sentiment-pill.tsx`, `geg-pill.tsx`, `inline-editable-field.tsx`, etc.) and what each is for.
   - The tokens (`app/globals.css` `--color-geg-*` variables) and the typography pairing (Newsreader serif + JetBrains Mono).
   - Any precedent designs Design should reference for continuity. The Gregory Calls + Clients + Ella redesign mocks were the original references during the May 2026 redesign; they've since been archived to git history (search the log for `Gregory <Surface> Redesign.html` to find them). For new work, point Design at the live shipped surfaces (e.g. "match the chrome of `/clients/[id]`") rather than dead-path HTML files.
   - What is **not** in scope (column changes, data shape changes, etc. — anything that needs a separate spec).

3. **Drake hands the prompt to Claude Design.** Design is a separate claude.ai session (no relation to Director's session) with the GitHub MCP connector authorized for this repo. Design produces an annotated single-file HTML mock and commits it to the repo (recent precedent placed the mocks at the repo root as `Gregory <Surface> Redesign.html`; future Design sessions are free to use any path Drake confirms). The mock is self-contained — fonts via Google Fonts, all styles inline, annotated with overlay labels that explain each surface. Design's commit lands directly on `main` via the MCP `create_or_update_file` call.

4. **Director reads the mock and writes a UI spec for Builder.** The UI spec at `docs/specs/<slug>.md` references the mock by path, the primitives by name, and the data fields available. Builder reads the spec + the mock + the primitives + the data layer, then implements. Drake hands the spec to Builder via the `/run` cue (or types `/run` himself in a Code session pointed at the spec).

## Builder's role

- Read the UI spec, the mock, `docs/fulfillment/gregory-conventions.md`, the data layer for the surface, and the existing primitives.
- Implement using existing primitives and tokens. **Do not paint raw hex** — every color comes from a `--color-geg-*` variable; every spacing / typography decision references the established system.
- Visually verify on the deploy preview via Playwright (see § Preview-auth bypass). Each surface family has a verifier:
  - Calls: `scripts/verify-calls-preview.ts`.
  - Clients: `scripts/verify-clients-preview.ts`.
  - New surface family: add a new verifier matching the pattern (load the list, screenshot, load the first detail row, screenshot, dump computed border style for any feature that's prone to silent-fail).
- Iterate on visual mismatches until the screenshot matches the mock at the 1440 baseline. Embed the final screenshots in the report.

## The preview-auth bypass

Visual verification needs to hit the Vercel preview without an auth cookie dance. The mechanism is `NEXT_PUBLIC_DISABLE_AUTH=true` set **only on Preview** in Vercel — never on Production.

The bypass is env-gated in `app/(authenticated)/layout.tsx`. When the env var is unset (Production default), normal Supabase auth runs and unauthenticated requests redirect to `/login`. When the env var is `'true'` (Preview only), the layout returns a stub user and the rest of the tree renders as if signed in.

Builder injects no cookie; the preview URL (`https://ai-enablement-git-<branch>-...vercel.app/clients`) is open. The Playwright scripts at `scripts/verify-*.ts` just `goto()` and screenshot.

**Deploy checklist:** any deploy that ships to Production must confirm `NEXT_PUBLIC_DISABLE_AUTH` is unset (or `'false'`) on Production env. Drake handles this gate via Vercel dashboard (gate (d) — credentials / env vars).

## Spec / report cleanup

- Design hand-off HTML mocks were initially intended to stay as the durable visual reference. The 2026-05-14 wrap retired that pattern: once the redesign ships and the live preview is the source of truth, the HTML mock becomes redundant artifact. Past mocks are archived to git history. New Design sessions can leave their mock in place during the spec → build → ship cycle; cleanup happens in the next EOD wrap.
- The redesign spec + Builder's report follow the standard EOD cleanup cadence (CLAUDE.md § Spec and report convention § Cleanup cadence) — Drake batches deletions when the work ships.

## What can go wrong + mitigations

- **Design produces a mock that doesn't reference existing primitives.** Mitigation: the Design-facing prompt is where this gets prevented — Director explicitly enumerates the primitives + tokens + precedent mocks. Catch in Director's prompt review, not in Builder's implementation.
- **Code visually drifts from the mock.** Mitigation: Playwright screenshots in Builder's verification step. Embed in the report; mismatch is visible.
- **Preview-auth bypass left on in Production.** Mitigation: the env var is scoped to Preview env in Vercel by configuration; Production env never had it set. A bad deploy would have to explicitly add it to Production — caught at gate (d).
- **Data layer needed by the mock doesn't exist yet.** Mitigation: split into a pre-design data-layer spec (Builder ships first) then a UI spec referencing the now-existing fields. The Calls redesign worked this way (`docs/specs/gregory-redesign-part-2-calls-data-layer.md` first, then the UI spec).
- **Builder ships and Playwright shows divergence at the column / section level.** Often this is the mock having dropped something the existing surface needs (the Clients redesign mock had 7 columns but Drake wanted all 9 kept). Drake calls these out at spec time; if missed, Builder surfaces in Surprises and Drake adjusts the next pass.
