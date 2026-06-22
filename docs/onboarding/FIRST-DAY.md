# First day

Goal: get the repo running locally — Python tests passing and the dashboard up — and know where to look
for everything else. Budget ~30–60 minutes. For the bird's-eye view first, skim the [README](../../README.md)
and [`docs/fulfillment/architecture.md`](../fulfillment/architecture.md); this doc is the do-it-step-by-step
companion.

> The repo is **mid-handoff** — ownership is moving to the company. If you're the person taking it over,
> read [`docs/handoff/00-overview.md`](../handoff/00-overview.md) before anything else; it explains what's
> transferring and what's already done.

## 0. Prerequisites

- **WSL2** if you're on Windows — work *inside* the WSL filesystem, not the Windows mount (`/mnt/c/...`).
  Setup: [`docs/runbooks/setup_wsl.md`](../runbooks/setup_wsl.md).
- **Python 3.11+**, **Node 18+**, **git**, and the **Supabase CLI**.

## 1. Clone (inside WSL)

```bash
git clone <repo-url>
cd ai-enablement
```

## 2. Python environment → confirm tests pass

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/ -q
```

The bulk of the suite is offline unit tests and should pass on a clean checkout. A few integration tests
may need `.env.local` (step 3) or touch live surfaces — if you hit those before you have credentials,
scope your run (e.g. `pytest tests/agents -q`) until you've confirmed which ones reach external systems.
Ask whoever holds the credentials (see step 3) before doing a full run against real services.

## 3. The dashboard → confirm it loads

```bash
cp .env.example .env.local        # template; fill in real values
npm install
npm run dev                       # → http://localhost:3000
```

- **Credentials:** `.env.example` lists every variable with a comment. You'll need at least the Supabase
  keys for the dashboard to show data. The authoritative inventory of every account/key and who owns it is
  [`docs/handoff/03-ownership-transfer.md`](../handoff/03-ownership-transfer.md) — get the real values from
  the credential owner; never commit `.env.local`.
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

The [README's "Where to find things" table](../../README.md#where-to-find-things) is the full map. The short
version:

- **How it all fits together** → [`docs/fulfillment/architecture.md`](../fulfillment/architecture.md) (CSM side) and [`docs/sales/`](../sales/README.md) (sales side).
- **Conventions + critical rules before you edit code** → [`CLAUDE.md`](../../CLAUDE.md) and [`docs/fulfillment/conventions.md`](../fulfillment/conventions.md).
- **A specific table** → [`docs/schema/`](../schema/) · **a specific agent** → [`docs/agents/`](../agents/) · **how to run/operate a task** → [`docs/runbooks/`](../runbooks/).

**One expectation to set:** the docs are kept accurate but **not exhaustive** — there isn't a doc for every
subsystem. When a doc is missing or you're unsure, **the code is the source of truth**: start from the
relevant `api/` handler, `ingestion/<source>/` module, or `agents/<name>/` package.
