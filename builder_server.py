"""Builder MCP server — Phase 1 scaffold for the Director / Builder system.

The Director (an interactive Claude Code session) calls `delegate_to_builder` to
spawn a headless `claude -p` subprocess (the Builder) that executes work in the
same repo. Builder's session is preserved across delegate calls via --resume,
so context carries forward.

Tools exposed:
- delegate_to_builder(instructions, context="") -> str
- reset_builder_session() -> str

The MCP server scrubs ANTHROPIC_API_KEY from the subprocess environment so
Builder runs on Drake's Max subscription rather than API billing.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP


_SESSION_FILE = Path(".claude") / "builder_session.txt"
_DEFAULT_TIMEOUT_SECONDS = 1800
_STDOUT_TRUNCATE_BYTES = 4000


if os.environ.get("ANTHROPIC_API_KEY"):
    print(
        "[builder_server] WARNING: ANTHROPIC_API_KEY detected in parent "
        "environment. Subprocess scrubbing is active, but be aware this "
        "variable is exported in your shell.",
        file=sys.stderr,
        flush=True,
    )


mcp = FastMCP("builder")


def _builder_cwd() -> Path:
    return Path(os.environ.get("BUILDER_CWD", os.getcwd()))


def _session_path() -> Path:
    return _builder_cwd() / _SESSION_FILE


def _read_session_id() -> str | None:
    path = _session_path()
    if not path.exists():
        return None
    sid = path.read_text(encoding="utf-8").strip()
    return sid or None


def _write_session_id(session_id: str) -> None:
    path = _session_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(session_id, encoding="utf-8")


def _compose_prompt(instructions: str, context: str) -> str:
    if context:
        return f"## Context\n{context}\n\n## Task\n{instructions}"
    return f"## Task\n{instructions}"


def _timeout_seconds() -> int:
    raw = os.environ.get("BUILDER_TIMEOUT")
    if not raw:
        return _DEFAULT_TIMEOUT_SECONDS
    try:
        value = int(raw)
        return value if value > 0 else _DEFAULT_TIMEOUT_SECONDS
    except ValueError:
        return _DEFAULT_TIMEOUT_SECONDS


def _scrubbed_env() -> dict[str, str]:
    env = os.environ.copy()
    env.pop("ANTHROPIC_API_KEY", None)
    return env


def _extract_primary_model(payload: dict) -> str | None:
    """Return the model id that incurred the highest cost in this run.

    The `claude -p --output-format json` payload exposes per-model usage under
    a top-level `modelUsage` dict (keyed by model id, with `costUSD` per
    entry). A single run commonly uses multiple models — e.g. the configured
    primary plus Haiku for auxiliary tasks. The most-expensive model is the
    one that actually did the work.

    Returns None when `modelUsage` is missing, empty, or otherwise unparseable
    so the footer can omit the field gracefully rather than crashing.
    """
    usage = payload.get("modelUsage")
    if not isinstance(usage, dict) or not usage:
        return None

    best_model: str | None = None
    best_cost = float("-inf")
    for model_id, stats in usage.items():
        if not isinstance(stats, dict):
            continue
        cost = stats.get("costUSD")
        if not isinstance(cost, (int, float)):
            continue
        if cost > best_cost:
            best_cost = cost
            best_model = model_id
    return best_model


def _format_footer(
    cost_usd: float | None,
    duration_ms: int | None,
    model: str | None,
) -> str:
    cost = f"${cost_usd:.4f}" if isinstance(cost_usd, (int, float)) else "?"
    if isinstance(duration_ms, (int, float)):
        seconds = duration_ms / 1000.0
        time_str = f"{seconds:.1f}s"
    else:
        time_str = "?"
    parts = [f"cost: {cost}", f"time: {time_str}"]
    if model:
        parts.append(f"model: {model}")
    return f"\n\n---\n[Builder run — {', '.join(parts)}]"


@mcp.tool()
def delegate_to_builder(instructions: str, context: str = "") -> str:
    """Spawn a headless Builder subprocess to execute the given task.

    The Builder runs `claude -p` with --output-format json and
    --dangerously-skip-permissions. ANTHROPIC_API_KEY is scrubbed from the
    subprocess environment so Builder uses the Max subscription. If a prior
    Builder session_id is on disk, it is resumed via --resume.

    Args:
        instructions: The task for Builder to execute.
        context: Optional supporting context. Omitted from the prompt entirely
            when empty.

    Returns:
        Builder's final result text plus a one-line footer with cost / time.
    """
    prompt = _compose_prompt(instructions, context)

    cmd: list[str] = [
        "claude",
        "-p",
        prompt,
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
        # Skip user-level ~/.claude/settings.json. Without this, Builder
        # inherits enabledPlugins (telegram@claude-plugins-official) and
        # the plugin's startup SIGTERMs the parent session's bot
        # subprocess on PID-file collision (server.ts: "Kill any stale
        # holder before we start polling"). Loading only project + local
        # keeps Builder isolated from Director's channel state. Side
        # effect: Builder loses user-level effortLevel/hooks/etc — fine
        # because Builder is execution-focused and project/local cover
        # the per-repo permission allowlist.
        "--setting-sources",
        "project,local",
    ]

    prior_session = _read_session_id()
    if prior_session:
        cmd.extend(["--resume", prior_session])

    cwd = str(_builder_cwd())
    timeout = _timeout_seconds()
    env = _scrubbed_env()

    try:
        completed = subprocess.run(
            cmd,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return (
            f"[builder_server] Builder timed out after {timeout}s. "
            "Increase BUILDER_TIMEOUT or split the task."
        )
    except FileNotFoundError:
        return (
            "[builder_server] `claude` CLI not found on PATH. Install Claude "
            "Code or update the MCP server PATH so the subprocess can spawn."
        )

    stdout = completed.stdout or ""
    stderr = completed.stderr or ""

    if completed.returncode != 0:
        truncated = stdout if len(stdout) <= _STDOUT_TRUNCATE_BYTES else (
            stdout[:_STDOUT_TRUNCATE_BYTES] + "\n…[stdout truncated]"
        )
        return (
            f"[builder_server] Builder exited with code {completed.returncode}.\n"
            f"stderr:\n{stderr.strip()}\n\nstdout:\n{truncated}"
        )

    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return (
            "[builder_server] Could not parse Builder JSON output. Raw stdout "
            f"follows:\n\n{stdout}"
        )

    result_text = payload.get("result") or "[builder_server] Builder returned no result text."
    new_session_id = payload.get("session_id")
    if isinstance(new_session_id, str) and new_session_id:
        try:
            _write_session_id(new_session_id)
        except OSError as exc:
            result_text += (
                f"\n\n[builder_server] WARNING: failed to persist session_id "
                f"to {_session_path()}: {exc}"
            )

    footer = _format_footer(
        payload.get("total_cost_usd"),
        payload.get("duration_ms"),
        _extract_primary_model(payload),
    )
    return f"{result_text}{footer}"


@mcp.tool()
def reset_builder_session() -> str:
    """Delete the saved Builder session id, forcing the next delegate call to
    start a fresh session.
    """
    path = _session_path()
    if not path.exists():
        return "No active Builder session to clear."
    try:
        path.unlink()
    except OSError as exc:
        return f"[builder_server] Failed to delete {path}: {exc}"
    return f"Cleared Builder session file at {path}."


if __name__ == "__main__":
    mcp.run()
