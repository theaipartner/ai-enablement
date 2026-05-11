# Report: Anthropic filesystem MCP server setup for Claude Desktop
**Date:** 2026-05-11

## What was changed

Added a single MCP server entry to Claude Desktop's config, scoped exclusively to the local ai-enablement repo. The server runs INSIDE WSL (via `wsl.exe -d Ubuntu -- npx ...`) for native filesystem performance + correct line-ending handling.

### File modified

`/mnt/c/Users/drake/AppData/Roaming/Claude/claude_desktop_config.json`

### Backup created

`/mnt/c/Users/drake/AppData/Roaming/Claude/claude_desktop_config.json.backup-20260511-025256`

(442 bytes — original config, pre-write.)

### Entry added

```json
"filesystem-ai-enablement": {
  "command": "wsl.exe",
  "args": [
    "-d", "Ubuntu",
    "--",
    "npx", "-y", "@modelcontextprotocol/server-filesystem",
    "/home/drake/projects/ai-enablement"
  ]
}
```

Existing `preferences` block was preserved unchanged. No other MCP servers existed in this file prior to the change (the GitHub MCP connector lives elsewhere — claude.ai-side connector config, not desktop JSON).

## Exact path scope

**`/home/drake/projects/ai-enablement`** — the canonical WSL path to this repo.

Note on the path discrepancy from the original prompt: the prompt said `~/ai-enablement` but `realpath ~/ai-enablement` resolved to `/home/drake/ai-enablement` which does not exist. The real repo (where every commit + test + doc landed during this session) is at `~/projects/ai-enablement`. Confirmed with Drake before writing — recommended option used: write the real path directly, no symlink papering.

Scope is **exactly one allowed root**. The filesystem MCP server treats every trailing positional arg as an allowed directory; we pass exactly one, so the server cannot access anything outside `/home/drake/projects/ai-enablement` even if a tool call attempts to.

## Verification done before / during write

- `node --version` → `v24.15.0` (well above the 18 minimum — no install needed; Drake's gate (d) didn't fire).
- `wsl -l -v` → `Ubuntu` (Running, version 2, default). Confirmed the exact distro string.
- `realpath ~/ai-enablement` → `/home/drake/ai-enablement` (nonexistent); surfaced + resolved with Drake via AskUserQuestion.
- `/home/drake/projects/ai-enablement/.git/` exists → confirmed it's a git repo.
- Windows username `drake` from `/mnt/c/Users/` listing (cmd.exe-from-WSL produced garbled output due to the UNC working-dir warning; the listing approach is cleaner).
- `npx -y @modelcontextprotocol/server-filesystem /home/drake/projects/ai-enablement` → starts cleanly (`Secure MCP Filesystem Server running on stdio`) and exits 0 on stdin close. Pre-cached the npm package at `~/.npm/_npx/a3241bba59c344f5/` so first-launch in Claude Desktop is fast.
- Pre-write JSON parse on the existing config → valid.
- Post-write JSON parse-back → valid; `preferences` preserved; new entry present with exactly one path; the path is the last positional arg as required.

## Restart steps (manual — Drake's gate)

The new MCP server only loads after Claude Desktop is restarted AND a fresh conversation is started.

1. **Quit Claude Desktop** completely. On Windows: right-click the Claude tray icon → Quit. Closing the window alone leaves the background process running and doesn't reload the config.
2. **Relaunch Claude Desktop.**
3. **Start a new conversation** (don't reuse an existing one). The filesystem MCP server's tools only become available to conversations created after the restart.

The current Code session that ran this setup will NOT see filesystem MCP tools — that's only for new Desktop (Director-side) conversations.

## Validation prompt for the new Desktop conversation

In a fresh Claude Desktop conversation, try this as the first prompt to confirm the server is wired:

> List the files in `/home/drake/projects/ai-enablement` and tell me what kind of project this is.

If it works, Claude will use the filesystem MCP `list_directory` / `read_file` tools to surface the repo structure + read CLAUDE.md. If the MCP server isn't loaded, Claude will respond without using tools (no filesystem access in the response).

Sanity follow-ups once the first prompt confirms it's working:

- "Read docs/agents/ella/ella.md and summarize the firm-after-first instruction."
- "What's in docs/specs/ that doesn't have a matching report?"
- "Edit CLAUDE.md to add a one-line note that filesystem MCP is configured for Director-side desktop conversations." (then check `git diff` from this Code session to verify the edit landed)

## Scope guarantee

The MCP server cannot read or write any path outside `/home/drake/projects/ai-enablement`. Specifically:

- It cannot reach `/home/drake/.env` or `~/.bashrc` or any other home-directory file.
- It cannot reach `/mnt/c/` (the Windows filesystem) or any other WSL distro.
- It cannot reach `/etc/` or any system path.
- It can read + write anything inside the repo, including `.env.local` (gitignored secrets) — Director-side Claude should follow the existing CLAUDE.md secrets-handling rules and never echo `.env.local` contents into the conversation.

## Idempotency

Re-running this setup detects the existing entry and exits without writing if the entry already matches. If the entry exists but differs (e.g., someone manually edited the path), the script overwrites it with the desired shape.

## Files touched by this work

- **Modified:** `/mnt/c/Users/drake/AppData/Roaming/Claude/claude_desktop_config.json`
- **Created:** `/mnt/c/Users/drake/AppData/Roaming/Claude/claude_desktop_config.json.backup-20260511-025256`
- **Created:** `docs/reports/filesystem-mcp-setup-2026-05-11.md` (this report)

No spec lived in `docs/specs/` for this work — it was a one-off setup task from Drake's prompt, not a Director-pushed spec. Report-only artifact in `docs/reports/` for the durable record.
