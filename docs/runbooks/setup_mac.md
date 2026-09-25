# Runbook: macOS Development Environment Setup

One-time setup for working on this repo on a Mac. Takes ~30 minutes. After this, follow
[`docs/onboarding/FIRST-DAY.md`](../onboarding/FIRST-DAY.md) to confirm everything runs.

## Prerequisites — account access

You need to be a member of all three before any of this is useful:

| Platform | What you need | Why |
|---|---|---|
| **GitHub** | Write access to `theaipartner/ai-enablement` | The code. Pushing to `main` deploys. |
| **Vercel** | Member of team `success-projects-9dcde12c`, project `ai-enablement` | Hosting, crons, and the authoritative env vars. |
| **Supabase** | Member of project `sjjovsjcfffrftnraocu` | The database — source of truth for all data. |

Plus access to the company Bitwarden vault for secrets Vercel won't hand back (see step 5).

## Step 1: Homebrew + core tools

```bash
# Homebrew (skip if `brew --version` already works)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install git gh python@3.11 node supabase/tap/supabase
npm install -g vercel
```

Verify:

```bash
python3.11 --version   # 3.11+
node --version         # 18+
supabase --version     # 2.90.0+
vercel --version
```

## Step 2: GitHub auth + clone

```bash
gh auth login          # GitHub.com → HTTPS → login with browser
git config --global user.name "Your Name"
git config --global user.email "you@example.com"

mkdir -p ~/code && cd ~/code
gh repo clone theaipartner/ai-enablement
cd ai-enablement
```

## Step 3: Python environment

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

Activate the venv (`source .venv/bin/activate`) in every new terminal before running Python.

## Step 4: Node dependencies

```bash
npm install
```

## Step 5: Secrets → `.env.local`

Pull the production env vars from Vercel into a local file:

```bash
vercel login
vercel link            # pick team success-projects-9dcde12c → project ai-enablement
vercel env pull .env.local --environment=production
```

Vercel returns **blank values for variables marked "Sensitive"**. Open `.env.local`, find any empty
`KEY=` lines you need, and fill them from Bitwarden. Then add for local dev:

```bash
NEXT_PUBLIC_DISABLE_AUTH=true     # bypasses dashboard login locally — never set in Vercel
```

`.env.local` is gitignored. Never commit it. Every variable is documented in `.env.example`, and the
account/owner/rotation map is [`credentials-and-accounts.md`](credentials-and-accounts.md).

**Caution:** `.env.local` now points at the **production** Supabase database. Scripts with an
`--apply` flag write real data — run `--smoke` / dry-run first (see `AGENTS.md` § Operational Discipline).

## Step 6: Link the Supabase CLI (only needed for migrations)

```bash
supabase login
supabase link --project-ref sjjovsjcfffrftnraocu
```

Before applying migrations, read [`apply_migrations.md`](apply_migrations.md). Don't run a local
Supabase stack (`supabase start`) at the same time as a cloud push.

## Step 7: Codex

The repo's agent instructions live in `AGENTS.md` at the root, which Codex reads automatically. Open
Codex from the repo root (`cd ~/code/ai-enablement && codex`). The file tells the agent the rules;
the most important one for you is that **pushing to `main` deploys to production**.

## Daily workflow

```bash
cd ~/code/ai-enablement
git pull
source .venv/bin/activate
```

## Common issues

- **Dashboard loads but shows no data** → Supabase vars in `.env.local` are blank (Sensitive in
  Vercel); fill from Bitwarden.
- **Supabase CLI "network is unreachable"** → add `--dns-resolver https` to the command.
