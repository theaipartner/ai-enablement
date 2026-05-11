# Report: filesystem MCP bash-wrap fix
**Slug:** filesystem-mcp-bash-wrap-fix
**Spec:** docs/specs/filesystem-mcp-bash-wrap-fix.md

## 1. Files touched

**Created:**
- `docs/reports/filesystem-mcp-bash-wrap-fix.md` — this report.

**Modified (outside the repo):**
- `/mnt/c/Users/drake/AppData/Roaming/Claude/claude_desktop_config.json` — edited the `args` array of the `filesystem-ai-enablement` entry. Every other byte in the file is intact (verified via JSON-tree diff against the original backup).

**Backups created (outside the repo):**
- `/mnt/c/Users/drake/AppData/Roaming/Claude/claude_desktop_config.json.bak-bashwrap-20260511-043305` — the original broken `npx`-as-4-separate-args shape.
- `/mnt/c/Users/drake/AppData/Roaming/Claude/claude_desktop_config.json.bak-bashic-20260511-043437` — intermediate `bash -c` state from my first write attempt, before I caught the bash-non-interactive-doesn't-source-nvm issue and re-wrote to `bash -ic`.

## 2. What I did, in plain English

Walked the acclimatization checklist, then applied the spec's literal fix (`bash -c` wrapping), but caught a deeper bug during the post-write pre-validation step: `wsl.exe -d Ubuntu -- bash -c 'which npx'` returns `/mnt/c/Program Files/nodejs//npx` — the **Windows npx**, not the WSL nvm-managed one. Non-interactive bash doesn't source `~/.bashrc` (where nvm initializes), so PATH only carries the appended-from-Windows nodejs directory. The spec's `bash -c` wrapper would have hit the same `C:\home\...` ENOENT failure as the original broken shape, just one wsl-shell layer deeper.

Probed four wrapper shapes empirically:

| Shape | wsl-side npx resolution | result |
|-------|------------------------|--------|
| `bash -c '...'` | `/mnt/c/Program Files/nodejs/npx` (10.9.2) — Windows | ✗ |
| `bash -lc '...'` (login shell) | `/mnt/c/Program Files/nodejs/npx` (10.9.2) — Windows | ✗ (Drake has no `.bash_profile`, his `.profile` doesn't source nvm) |
| `bash -ic '...'` (interactive — sources `.bashrc`) | `/home/drake/.nvm/versions/node/v24.15.0/bin/npx` (11.12.1) — **WSL native** | ✓ |
| `wsl.exe -- /home/drake/.nvm/.../npx` (absolute) | fails — npx shebang can't find `node` on PATH | ✗ |

Picked Shape B (`bash -ic`). Confirmed it produces clean stdout for MCP-server stdio JSON-RPC (no `.bashrc` greeting noise) and that the actual MCP server starts successfully (`Secure MCP Filesystem Server running on stdio`) when launched through the wsl.exe → bash -ic chain.

Re-wrote the config with `bash -ic` in place of `bash -c`. Kept the original backup; added a second backup before the re-write so both intermediate states are recoverable.

**Deviation from the spec's literal text:** the spec specified `bash -c`. I shipped `bash -ic`. The spec's stated intent ("bash spawns inside Ubuntu, npx resolves from WSL Node") is preserved; the literal flag was wrong because the spec author didn't anticipate Drake's nvm-via-`.bashrc` setup. Standing instruction is "If you have a strong lean and the consequence of being wrong is recoverable, make the call and note it." Recoverable (two backups available, one-line revert). Made the call.

## 3. Verification

**Pre-write acclimatization:**
- Config existed at `/mnt/c/Users/drake/AppData/Roaming/Claude/claude_desktop_config.json` (729 bytes, parses as valid JSON, top-level keys `['preferences', 'mcpServers']`).
- LF line endings (32 LF, 0 CRLF). UTF-8 no BOM. Zero smart quotes anywhere.
- The `filesystem-ai-enablement` entry matched the known-broken shape exactly. The only entry under `mcpServers` — no other entries to preserve.
- WSL node `v24.15.0` at `/home/drake/.nvm/versions/node/v24.15.0/bin/node`. WSL npx 11.12.1 at the same prefix.
- Target path `/home/drake/projects/ai-enablement/.git/HEAD` is a real 21-byte file.

**Post-write validation:**
- Roundtrip parse OK; top-level keys preserved.
- New args: `['-d', 'Ubuntu', '--', 'bash', '-ic', 'npx -y @modelcontextprotocol/server-filesystem /home/drake/projects/ai-enablement']`.
- Diff vs original backup: only the args array of `filesystem-ai-enablement` differs. `preferences` block byte-identical. The `command` field stays `"wsl.exe"`.
- Zero smart quotes in the output.

**Launch prereq verification** (the spec's Step 5 — verify without launching the stdio server in a way that hangs):
```
$ wsl.exe -d Ubuntu -- bash -ic 'which npx && npx --version'
/home/drake/.nvm/versions/node/v24.15.0/bin/npx
11.12.1

$ wsl.exe -d Ubuntu -- bash -ic 'ls -la /home/drake/projects/ai-enablement/.git/HEAD'
-rw-r--r-- 1 drake drake 21 May 10 01:58 /home/drake/projects/ai-enablement/.git/HEAD

$ timeout 3 wsl.exe -d Ubuntu -- bash -ic 'npx -y @modelcontextprotocol/server-filesystem /home/drake/projects/ai-enablement' < /dev/null
Secure MCP Filesystem Server running on stdio
(exit 0)
```

All three prereqs hit the WSL-native installation correctly. The server starts cleanly when stdin closes; would handle real JSON-RPC over Claude Desktop's stdio pipe the same way.

## 4. Surprises and judgment calls

- **The spec's literal `bash -c` wouldn't have worked.** `bash -c` is a non-interactive shell, doesn't source `~/.bashrc`, and Drake's nvm initialization lives only in `.bashrc` (he has no `.bash_profile`). The Windows nodejs at `/mnt/c/Program Files/nodejs/` gets onto PATH via `/etc/wsl.conf`'s `interop.appendWindowsPath = true` setting, and a fresh bash with no `.bashrc` sourcing picks the Windows npx first. End-result would have been identical to the original bug: `C:\home\...` ENOENT.

- **Shape A (`bash -lc`) also fails** for the same root cause but a slightly different mechanism: login shell sources `~/.bash_profile` → `~/.profile`, neither of which sources nvm on Drake's machine. Only `~/.bashrc` (sourced by interactive shells, hence `-ic`) does. If a future contributor's nvm sits in `.bash_profile`, Shape A would work for them and Shape B might not — but Shape B is empirically what Drake's machine needs.

- **The Windows npx didn't fail loudly when invoked via WSL.** It found a node binary (Windows-side `node.exe`) and tried to interpret `/home/drake/projects/ai-enablement` as a relative path against the cwd, which inside Windows-context is `C:\` — producing the misleading `C:\home\drake\projects\ai-enablement` path in the original error. If WSL's PATH had ordered the Windows nodejs LAST (or excluded it), the `bash -c` version of the spec would have worked. The order is a wsl.conf-level setting; reasoning about it across machines is brittle.

- **`bash -ic` interactive-shell caveats.** Two potential concerns I checked: (a) does `.bashrc` print greeting noise to stdout? Empirically no — Drake's `.bashrc` is clean for non-prompt output. (b) Does interactive bash try to engage job control and emit warnings about no TTY? Empirically also no — stderr was clean during the timed launch test. Both confirmed empirically; if a future bashrc edit adds greeting output, the MCP stdio stream could break with extra non-JSON bytes — flag this for future-Builder.

- **The second backup** (`.bak-bashic-20260511-043437`) captures the intermediate `bash -c` state from my first write attempt. Kept it so that if Drake wants to A/B-test or revert, both broken shapes are recoverable. Could be deleted after Drake confirms the fix works — Director's call.

- **No `github` entry in this config file.** The original setup report ran into the same surprise: the GitHub MCP connector lives on Director-side claude.ai, not in this desktop JSON. Spec hypothesized there might be a GitHub entry to preserve; reality is `filesystem-ai-enablement` is the only `mcpServers` entry.

- **bash -ic non-interactive-stdio gotcha worth noting for future fixes.** Anything that runs under Claude Desktop's MCP launch — present or future — should use `bash -ic` to reach the nvm-managed Node, OR switch the Node install to a non-nvm method (apt, fnm, or a Node version manager that initializes from `.profile` rather than `.bashrc`).

## 5. Out of scope / deferred

- **Fix B (UNC path with plain Windows npx).** Spec's documented fallback if `bash -c`/`-ic` triggers a different failure mode in older wsl.exe versions. Not applied; not needed. Documented here as the next-step recovery if Drake's restart of Desktop fails with a new error (not the original `C:\home\...` ENOENT).

- **Removing the second backup file.** Both backups remain in place. Director's call whether to clean up post-Drake-validation.

- **Switching to a non-nvm Node install on WSL.** Would make `bash -c` (no `-i`) work the way the spec assumed. Larger change than this fix's scope; not pursued.

- **Path-quoting inside the bash command string.** The current path has no spaces, so the bash command string doesn't need escaping. If a future contributor scopes the MCP server to a path with a space, the entire bash command string (last arg) needs internal `\` escaping or different quoting. Future awareness; not in scope today.

## 6. Side effects

- **Modified `/mnt/c/Users/drake/AppData/Roaming/Claude/claude_desktop_config.json`** (outside the repo). Two backup copies sit alongside it.
- **No git activity beyond this report.** The config is outside any git tree.
- **No npm install or Node runtime change.** Used the pre-existing WSL nvm Node at `~/.nvm/versions/node/v24.15.0/`.
- **No production data writes.** No cloud, no DB, no Slack.
- **The timed launch test** (`timeout 3 wsl.exe -- bash -ic 'npx ...' < /dev/null`) started a real MCP server process for ~3 seconds against the real ai-enablement path. The server is stdio-only and exited cleanly on stdin close; no files were read or written through it during that test.

---

## Drake's next steps

The config is in its final state. Manual steps to bring the fix live:

1. **Fully exit Claude Desktop** from the system tray (right-click tray icon → Exit). Closing the window alone leaves the background process running and doesn't reload the config.
2. **Relaunch Claude Desktop.**
3. **Open a brand-new conversation** (not an existing one — MCP tool list is frozen per-conversation at conversation start).
4. **Smoke test with a read prompt** like:

   > List the files at the root of `/home/drake/projects/ai-enablement` and tell me what kind of project this is.

   If the fix worked, Claude in the new chat returns the real file listing (uses the `list_directory` MCP tool, then probably `read_file` on `CLAUDE.md`). If still broken, capture the new MCP log content at `%APPDATA%\Claude\logs\mcp-server-filesystem-ai-enablement.log` (or `/mnt/c/Users/drake/AppData/Roaming/Claude/logs/...` from WSL) and send it back to Director — they'll scope Fix B (UNC path with plain Windows npx) as the next-step recovery spec.

## Fallback if `bash -ic` still fails

If the next restart produces a new error (not `C:\home\...` ENOENT), the most likely fallback is **Fix B** — switch the config to use the UNC path `\\wsl$\Ubuntu\home\drake\projects\ai-enablement` with plain Windows npx. Trade-off: filesystem performance drops (file ops go over the WSL2 9P bridge), line-ending handling may diverge between the npm package and the WSL git tree, but it sidesteps the WSL-shell-flavor complexity entirely. Director would scope this as a new spec if needed; not applied tonight.
