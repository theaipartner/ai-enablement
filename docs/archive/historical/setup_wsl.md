# Runbook: WSL2 Development Environment Setup

One-time setup to get a Windows machine ready for this project. Takes 30-60 minutes.

## Why WSL2

- Python libraries (especially AI/ML) assume Linux; fewer dependency compilation errors
- File paths and shell scripts work the way tutorials and docs describe
- Supabase CLI, n8n, and most dev tools work more reliably
- Claude Code runs smoother

You can still use Windows for everything else (browser, Slack, Notion). WSL is just for this project's development work.

## Prerequisites

- Windows 10 (version 2004+) or Windows 11
- Administrator access
- WSL2 and Ubuntu already installed

## Step 1: Update Ubuntu

Open the Ubuntu terminal (from Start menu or Windows Terminal).

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential curl git wget unzip
```

## Step 2: Install Python 3.11+

```bash
sudo apt install -y python3 python3-pip python3-venv
python3 --version  # confirm 3.11 or higher
```

If version is below 3.11, install a newer one via deadsnakes PPA:

```bash
sudo add-apt-repository ppa:deadsnakes/ppa -y
sudo apt update
sudo apt install -y python3.11 python3.11-venv python3.11-dev
```

## Step 3: Install Node.js (for frontend work and some tooling)

Use nvm to manage Node versions:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# Close and reopen the terminal, then:
nvm install --lts
nvm use --lts
node --version
```

## Step 4: Configure Git

```bash
git config --global user.name "Your Name"
git config --global user.email "your-github-email@example.com"
git config --global init.defaultBranch main
```

Set up SSH or GitHub CLI for pushing. Recommend GitHub CLI for simplicity:

```bash
sudo apt install -y gh
gh auth login
```

## Step 5: Install VS Code with WSL Extension

On Windows (not inside WSL):
1. Install VS Code from https://code.visualstudio.com/ if not already installed
2. Install the "WSL" extension (by Microsoft) from the Extensions marketplace

To open a WSL project in VS Code:
- From the Ubuntu terminal, `cd` to the project directory and run `code .`
- VS Code opens on Windows but edits files inside WSL transparently
- The terminal inside VS Code will also be a WSL terminal

## Step 6: Install Project Tools

Inside WSL:

```bash
# Docker (for local n8n, Supabase CLI, etc.)
# Docker Desktop on Windows with WSL integration is the easiest path.
# Install Docker Desktop on Windows, then enable WSL integration in its settings.

# Supabase CLI
npm install -g supabase

# Verify
supabase --version
```

## Step 7: Project Directory Location (Important)

**Clone repos inside the WSL filesystem, not the Windows filesystem.**

Good: `~/projects/ai-enablement` (lives at `/home/<user>/projects/ai-enablement` inside WSL)

Bad: `/mnt/c/Users/<user>/projects/ai-enablement` (lives on Windows filesystem, accessed through WSL — much slower and causes weird bugs)

```bash
mkdir -p ~/projects
cd ~/projects
# Clone the repo here when ready:
# git clone git@github.com:theaipartner/ai-enablement.git
```

## Step 8: Install Claude Code (inside WSL)

Follow the Claude Code installation instructions for Linux. It runs natively in WSL.

## Daily Workflow

- Open Windows Terminal or VS Code
- Start a WSL/Ubuntu session
- `cd ~/projects/ai-enablement`
- Work normally — Python, git, Claude Code, npm all behave as they would on a Mac or Linux machine

## Common Issues

**"Cannot connect to the Docker daemon" error:**
- Ensure Docker Desktop is running on Windows
- In Docker Desktop settings, enable WSL integration for Ubuntu

**Slow file operations:**
- You're probably editing files in `/mnt/c/...` — move the project to `~/projects/...` instead

**Python package install fails with "gcc not found" or similar:**
- Run `sudo apt install -y build-essential python3-dev`

## Updating This Runbook

Add new issues and fixes here as they come up. Future-you and future-teammates will thank present-you.
