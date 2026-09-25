# First day

Goal: get the repo running locally — Python tests passing and the dashboard up — and know where to look
for everything else. Budget ~30–60 minutes. For the bird's-eye view first, skim the [README](../../README.md)
and [`docs/fulfillment/architecture.md`](../fulfillment/architecture.md); this doc is the do-it-step-by-step
companion.

## 0. Prerequisites

- A Mac set up per [`docs/runbooks/setup_mac.md`](../runbooks/setup_mac.md) — Homebrew, Python 3.11+,
  Node 18+, git/gh, the Supabase CLI, the Vercel CLI, and access to GitHub + Vercel + Supabase.

## 1. Clone

```bash
gh repo clone theaipartner/ai-enablement
cd ai-enablement
```

## 2. Python environment → confirm tests pass

```bash
python3.11 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/ -q
```

The bulk of the suite is offline unit tests and should pass on a clean checkout. A few integration tests
may need `.env.local` (step 3) or touch live surfaces — if you hit those before you have credentials,
scope your run (e.g. `pytest tests/agents -q`) until you've confirmed which ones reach external systems.
Ask whoever holds the credentials (see step 3) before doing a full run against real services.

## 3. The dashboard → confirm it loads

```bash
vercel link                       # team success-projects-9dcde12c → project ai-enablement
vercel env pull .env.local --environment=production
npm install
npm run dev                       # → http://localhost:3000
```

- **Credentials:** `vercel env pull` fills `.env.local` from Vercel, but variables marked Sensitive come
  down blank — fill those from Bitwarden. `.env.example` documents every variable. You'll need at least
  the Supabase keys for the dashboard to show data. The authoritative inventory of every account/key and who owns it is
  [`docs/runbooks/credentials-and-accounts.md`](../runbooks/credentials-and-accounts.md) — get the real
  values from the credential owner; never commit `.env.local`.
- **Local auth:** set `NEXT_PUBLIC_DISABLE_AUTH=true` in `.env.local` so the dashboard's login gate is
  bypassed locally. (Never set this in production.)
- Type-check + lint the dashboard with `npm run build` and `npm run lint`.

## 4. Deploys (how it ships)

You don't deploy manually — pushing to `main` triggers Vercel's GitHub integration, which builds and
deploys the Next.js app + the Python serverless functions in `api/`. Cron schedules live in `vercel.json`
(human-readable ET mapping in [`docs/runbooks/cron_schedule.md`](../runbooks/cron_schedule.md)).

## You're set up when…

- [ ] `pytest tests/ -q` runs (green, or only failing on tests that clearly need credentials).
- [ ] `npm run dev` serves the dashboard at `http://localhost:3000`.
- [ ] You can open `/clients` and `/calls` (with `NEXT_PUBLIC_DISABLE_AUTH=true` and real Supabase keys).

## Where to look next

**New to the codebase (or to git)?** Open Codex in the repo and say *"teach me the codebase"*. It will
follow [`LEARNING-PATH.md`](LEARNING-PATH.md), a step-by-step course from git basics to tracing data
through the system.

The [README's "Where to find things" table](../../README.md#where-to-find-things) is the full map. The short
version:

- **How it all fits together** → [`docs/fulfillment/architecture.md`](../fulfillment/architecture.md) (CSM side) and [`docs/sales/`](../sales/README.md) (sales side).
- **Conventions + critical rules before you edit code** → [`AGENTS.md`](../../AGENTS.md) and [`docs/fulfillment/conventions.md`](../fulfillment/conventions.md).
- **A specific table** → [`docs/schema/`](../schema/) · **a specific agent** → [`docs/agents/`](../agents/) · **how to run/operate a task** → [`docs/runbooks/`](../runbooks/).

**One expectation to set:** the docs are kept accurate but **not exhaustive** — there isn't a doc for every
subsystem. When a doc is missing or you're unsure, **the code is the source of truth**: start from the
relevant `api/` handler, `ingestion/<source>/` module, or `agents/<name>/` package.
