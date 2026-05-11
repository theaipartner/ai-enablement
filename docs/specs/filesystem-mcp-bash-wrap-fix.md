# Fix filesystem MCP server launch — bash -c wrapping inside wsl.exe
**Slug:** filesystem-mcp-bash-wrap-fix
**Status:** in-flight

## Context

Earlier tonight (commit `020d180`) you set up the Anthropic filesystem MCP server for Claude Desktop, scoped to `/home/drake/projects/ai-enablement`. The config was written to `/mnt/c/Users/drake/AppData/Roaming/Claude/claude_desktop_config.json` with this shape:

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

Drake restarted Claude Desktop and the server failed to launch. The MCP log (`%APPDATA%\Claude\logs\mcp-server-filesystem-ai-enablement.log`, viewable from WSL at `/mnt/c/Users/drake/AppData/Roaming/Claude/logs/...`) shows:

```
Error accessing directory C:\home\drake\projects\ai-enablement
ENOENT: no such file or directory, stat 'C:\home\drake\projects\ai-enablement'
```

**Root cause:** the launch pattern `wsl.exe -d Ubuntu -- npx -y @modelcontextprotocol/server-filesystem /home/drake/projects/ai-enablement` does NOT actually run `npx` inside WSL the way we wanted. With this arg shape, `wsl.exe` passes the rest of the args to its own arg parser, and `npx` ends up resolving against the Windows-side PATH (`C:\Program Files\nodejs\` is in Drake's Windows PATH per the log). Windows `npx` then tries to access the path `/home/drake/projects/ai-enablement` as a Windows path relative to `C:`, yielding `C:\home\drake\projects\ai-enablement` — which doesn't exist.

**Fix:** wrap the command in `bash -c` so wsl.exe spawns a bash shell inside Ubuntu, and bash resolves `npx` from WSL's Node installation. The path `/home/drake/projects/ai-enablement` is then interpreted as a Linux path against WSL's filesystem (where the repo actually lives).

The intended final config shape:

```json
"filesystem-ai-enablement": {
  "command": "wsl.exe",
  "args": [
    "-d", "Ubuntu",
    "--",
    "bash", "-c",
    "npx -y @modelcontextprotocol/server-filesystem /home/drake/projects/ai-enablement"
  ]
}
```

Note: the last three args are `"bash"`, `"-c"`, and the entire `npx ... /path` as a single string. Not four separate args.

## Acclimatization checklist — confirm in 3-4 bullets before any writes

1. **Read the existing config** at `/mnt/c/Users/drake/AppData/Roaming/Claude/claude_desktop_config.json`. Confirm it parses as valid JSON. If it doesn't parse, STOP and surface — don't try to repair an already-broken file.
2. **Confirm the `filesystem-ai-enablement` entry exists** under `mcpServers` and matches the broken shape described above (command=wsl.exe, args ending with npx + path as 4 separate elements). If the entry is missing, has been manually edited since the original setup, or has a different shape than expected — STOP and report what you see. Don't blindly overwrite.
3. **Capture every other `mcpServers` entry** (the `github` entry minimally; possibly others). These MUST remain intact and unchanged after the edit. The expected behavior is "modify ONLY the filesystem-ai-enablement entry's args; leave every other entry byte-identical."
4. **Verify Node.js is still available inside WSL** for the new launch path to work: `which node && node --version` from inside WSL. Min version 18. If it's gone for some reason, surface — the fix is moot if Node isn't installed.
5. **Verify the target path exists**: `/home/drake/projects/ai-enablement` should be a directory containing a `.git/` subfolder. Confirm via `realpath` and `ls`. If the path has changed or doesn't exist, surface — there's a deeper problem.

## Goal

Edit ONLY the `args` array of the `filesystem-ai-enablement` entry in `claude_desktop_config.json` to use the `bash -c` wrapper. Leave the rest of the file byte-identical. Validate, back up, write, verify.

## What success looks like

1. **Pre-write backup.** Copy the existing config to `claude_desktop_config.json.bak-bashwrap-<timestamp>` in the same directory. Report the backup path. If a backup with the same timestamp somehow already exists (shouldn't, but defensive), append a counter.

2. **Edit the args array** to match the intended shape exactly:
   ```json
   "args": [
     "-d", "Ubuntu",
     "--",
     "bash", "-c",
     "npx -y @modelcontextprotocol/server-filesystem /home/drake/projects/ai-enablement"
   ]
   ```
   The first three elements (`-d`, `Ubuntu`, `--`) are unchanged from the original. The last 4 elements get replaced with 3 elements (`bash`, `-c`, the full command as one string).

3. **Validate the file before writing:**
   - Parse the in-memory modified JSON to confirm validity.
   - Diff against the original: ONLY the `args` array of `filesystem-ai-enablement` should differ. The `command` field stays `"wsl.exe"`. The `github` entry (and any others) stay byte-identical.
   - Quote-character check: confirm no smart quotes (`"` `"` `'` `'`) anywhere in the new content. Only straight ASCII quotes (`"` and `'`).
   - Encoding: write as UTF-8 without BOM. Match whatever line endings the original used (probably LF, but preserve consistency).

4. **Write the file** to `/mnt/c/Users/drake/AppData/Roaming/Claude/claude_desktop_config.json` via the cross-mount. After writing, re-read it and re-parse the JSON to confirm the on-disk state is what we intended. Report parsing OK.

5. **Pre-validate the launch command will work inside WSL** (without actually launching the MCP server in a way that hangs):
   - `wsl -d Ubuntu -- bash -c 'which npx && npx --version'` should succeed and print a version. If it doesn't, the fix won't work — surface.
   - `wsl -d Ubuntu -- bash -c 'ls -la /home/drake/projects/ai-enablement/.git/HEAD'` should succeed (proves the path is reachable and is a git repo from inside WSL).
   - DO NOT actually invoke `npx -y @modelcontextprotocol/server-filesystem ...` from Code — that command launches a stdio MCP server and will hang waiting for JSON-RPC input. Just verify the prerequisites (`npx` reachable, target path reachable). Drake's restart of Claude Desktop is what actually launches the server.

## Hard stops

- **Config file doesn't parse** before edit → surface, don't try to repair.
- **The `filesystem-ai-enablement` entry has been manually edited** since the original `020d180` commit and looks different from the broken shape we expect → surface and ask Drake what to do. Don't overwrite his manual changes.
- **The `github` MCP entry or any other entry differs after the edit** when diff'd against the original → revert from backup, surface, don't ship a corrupted config.
- **Node.js or npx unreachable inside WSL** → surface, fix is moot.
- **Target path `/home/drake/projects/ai-enablement` doesn't exist or isn't a git repo** → surface.
- **Cannot write to the config file** (permissions, locked file because Claude Desktop is running) → surface and tell Drake "Claude Desktop must be fully exited before this fix can apply; right-click tray icon → Exit, then re-run me."

## What could go wrong

- **Claude Desktop is running and holding a file lock.** Drake was told to fully quit Desktop before this spec runs, but if Code can't write, that's the most likely cause. Report cleanly: "config locked, Drake needs to fully exit Claude Desktop from the system tray and re-run."

- **The bash -c wrapping triggers a different failure mode in older wsl.exe versions.** Possible but unlikely on a modern Windows + WSL2 install. If post-edit, Drake's restart of Desktop produces a NEW error (not the C:\home\... ENOENT), surface in the report's "Out of scope / deferred" section as a known fallback to Fix B (UNC path: `\\wsl$\Ubuntu\home\drake\projects\ai-enablement` with plain Windows npx). Don't actually apply Fix B in this spec — just note it as the documented fallback.

- **Path-quoting inside the bash -c string.** The path `/home/drake/projects/ai-enablement` has no spaces, so quoting isn't required. If a future path included a space, the entire bash -c string would need internal escaping. Not an issue today; note in the report for future awareness.

- **The original config used different indentation or formatting** than your write would produce. Preserve the original's formatting as much as possible — match indent character (spaces vs tabs) and indent width. Run-of-the-mill JSON tooling collapses to 2-space indent which is fine if that's what the original used. If the original was differently formatted, match it to keep diffs minimal.

- **Smart quote contamination from previous manual editing.** Defensive: scan the entire file for U+201C / U+201D / U+2018 / U+2019 characters; if any are present (even outside the section you're editing), surface and DO NOT write — Drake had a manual editor session that auto-converted quotes and the file is silently broken in another section.

## Mandatory doc updates

None for this spec. The original setup report at `docs/reports/filesystem-mcp-setup-2026-05-11.md` (or whatever Builder's commit `020d180` named it) can be appended to OR a new follow-up report can be written under a new slug — your call, but match the convention. If appending, add a clearly-marked "Follow-up 2026-05-11: bash -c wrap fix" section at the end. If new report, use this spec's slug.

## What Drake does after this report lands

Drake's manual steps that Builder cannot do:

1. **Fully exit Claude Desktop** from the system tray (if not already done).
2. **Relaunch Claude Desktop.**
3. **Open a brand-new conversation** (NOT the existing one — MCP tool list is frozen per-conversation at conversation start).
4. **Test with a read prompt** like "list files at the root of ai-enablement." If filesystem MCP works, Claude in that new chat returns the real file listing. If still broken, send the new MCP log content back to Director.

Builder includes these four steps in the report's final section so Drake has a clean checklist.

## Commit shape

One commit: the report. `docs: filesystem MCP bash-wrap fix report`.

The config file itself (`claude_desktop_config.json`) is OUTSIDE the repo — `/mnt/c/Users/drake/AppData/Roaming/Claude/` is Windows-side, not part of the ai-enablement git tree. So Code edits the config but doesn't commit it (can't — it's not in any git repo). Only the report commits.
