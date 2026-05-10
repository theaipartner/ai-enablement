"""Speaker identity resolution.

`resolve_speaker_identity(slack_user_id)` looks up the *real* author
of an @-mention against `clients.slack_user_id` first, then
`team_members.slack_user_id`. Returns a structured `SpeakerIdentity`
the rest of the agent uses for prompt rendering (Task 2) and audit
metadata (the `trigger_metadata` fields on `agent_runs`).

This module exists because V1's `slack_handler.py` collapsed the real
speaker with the channel-mapped client whenever a team_member posted
in a client channel — `agent_event["user"]` got rewritten to the
channel's client's slack_user_id so retrieval would scope correctly,
and the real triggering user was lost by the time `agent_runs.trigger_metadata`
was written. That impersonation produced the V2.4 wrong-name bug
(every speaker addressed as the channel's client). The fix is to
keep retrieval scope tied to the channel-mapped client (handled in
`agent.py`) while resolving the speaker separately here.

Lookup order: clients → team_members. A team_member match always
resolves to `role='advisor'` regardless of `team_members.is_csm` —
"advisor" is the public-facing name for any team_member who might
speak in a client channel, per Drake's chat clarification. CSM vs
non-CSM distinction doesn't affect prompt behavior in this scope.
"""

from __future__ import annotations

from dataclasses import dataclass

from shared.db import get_client


@dataclass(frozen=True)
class SpeakerIdentity:
    slack_user_id: str
    display_name: str
    role: str  # 'client' | 'advisor' | 'unresolvable'
    client_id: str | None = None
    team_member_id: str | None = None


def resolve_speaker_identity(slack_user_id: str | None) -> SpeakerIdentity:
    """Lookup order: clients → team_members. Returns unresolvable on no match.

    Empty / missing `slack_user_id` returns an unresolvable identity with
    `display_name='(unverified)'` so callers can pass it straight into a
    safer-fallback prompt path without branching on None.
    """
    if not slack_user_id:
        return SpeakerIdentity(
            slack_user_id="",
            display_name="(unverified)",
            role="unresolvable",
        )

    db = get_client()
    client_resp = (
        db.table("clients")
        .select("id,full_name")
        .eq("slack_user_id", slack_user_id)
        .is_("archived_at", "null")
        .execute()
    )
    if client_resp.data:
        c = client_resp.data[0]
        return SpeakerIdentity(
            slack_user_id=slack_user_id,
            display_name=c["full_name"],
            role="client",
            client_id=c["id"],
        )

    team_resp = (
        db.table("team_members")
        .select("id,full_name")
        .eq("slack_user_id", slack_user_id)
        .is_("archived_at", "null")
        .execute()
    )
    if team_resp.data:
        t = team_resp.data[0]
        return SpeakerIdentity(
            slack_user_id=slack_user_id,
            display_name=t["full_name"],
            role="advisor",
            team_member_id=t["id"],
        )

    return SpeakerIdentity(
        slack_user_id=slack_user_id,
        display_name="(unverified)",
        role="unresolvable",
    )
