# Runbook: Slack Events Webhook (Ella)

How to operate the Vercel serverless function that receives Slack `app_mention` events and routes them into Ella. Covers redeploy, logs, rollback, and signing-secret rotation.

## Where the code lives

- `api/slack_events.py` — the webhook handler. Vercel auto-routes `api/*.py` as individual serverless functions; the production URL for this one is `https://<vercel-project>.vercel.app/api/slack_events`.
- `vercel.json` — function config. Pins `runtime: @vercel/python@4.3.1` (required for Vercel to register `api/*.py` as Serverless Functions when the `functions` block is declared) and sets `maxDuration: 60` so Ella's synchronous roundtrip has headroom before the invocation is killed.
- `requirements.txt` — Vercel installs Python deps from here at build time. Kept in sync by hand with `[project.dependencies]` in `pyproject.toml`.
- `agents/ella/slack_handler.py` — the handler the webhook calls into. Routing rules and team-test mode logic live there; do not duplicate them in the webhook layer.

## Architecture (why this is synchronous)

Slack retries any webhook that doesn't return 200 within 3 seconds. Ella's full roundtrip (retrieval → Claude → Slack post) takes 3–10 seconds, which doesn't fit. The natural shape would be *"ack first, do the work in a background thread"* — and that's what the first iteration of this code did. It didn't work: Vercel's Python runtime terminates the function process the moment `do_POST` returns, killing a non-daemon `threading.Thread` before it finishes `chat.postMessage`. Confirmed live on 2026-04-23 — every webhook returned 200, zero replies ever landed.

**V1 shape: synchronous handler + fast retry-acks.** We run everything inline and ack after the Slack post. Cold starts miss Slack's 3s window, Slack retries with `X-Slack-Retry-Num`, and the retry branch acks those immediately without re-processing so the user only sees one reply.

```
Slack → POST /api/slack_events
            ├── verify HMAC signature on raw body
            ├── handle url_verification challenge (if present)
            ├── detect X-Slack-Retry-Num → ack 200 fast, skip processing
            └── for app_mention:
                    [INFO: slack_webhook: processing app_mention channel=... user=...]
                    handle_slack_event(payload)        ← sync
                    chat.postMessage(thread_ts, ...)   ← sync
                    return 200 "ok"                     ~3s warm, ~5–10s cold
```

Cost: roughly 2x container-seconds per mention on a cold start — the first invocation does the full work, one or two fast retry-acks run concurrently. For V1 pilot volume this is fine. `vercel.json` sets `maxDuration: 60` as a hard ceiling on the full handler; if Ella's roundtrip ever exceeds that, the invocation is killed and no Slack post lands.

**Why not Fluid Compute.** Vercel's Fluid Compute runtime setting lets a handler return a response while work continues in the background — exactly what the threaded V0 was trying to do. It's a project-level opt-in we don't currently have enabled. Turning it on would let us move back to the ack-then-work pattern and cut user-visible latency back under 3s. Worth revisiting when pilot volume makes the cold-start lag uncomfortable; not worth bending the deploy ahead of the Monday launch.

## Required env vars on the Vercel project

Set all six via Vercel dashboard → Project Settings → Environment Variables. Mirror the values from `.env.local` exactly. **Never commit real values.** See `.env.example` for descriptions.

| Name | Used by |
|---|---|
| `SUPABASE_URL` | `shared/db.py` |
| `SUPABASE_SERVICE_ROLE_KEY` | `shared/db.py` |
| `ANTHROPIC_API_KEY` | `shared/claude_client.py` |
| `OPENAI_API_KEY` | `shared/kb_query.py` (embeddings) |
| `SLACK_BOT_TOKEN` | `api/slack_events.py` outbound `chat.postMessage` |
| `SLACK_SIGNING_SECRET` | `api/slack_events.py` inbound HMAC verification |

After changing any env var, **redeploy** — Vercel does not propagate env-var changes to running deployments.

## Redeploying

The Vercel project is linked to the GitHub repo; any push to `main` triggers a production deploy. So the standard loop is:

1. Edit `api/slack_events.py` (or `agents/ella/*`, `shared/*`, etc.).
2. `pytest tests/` — expect 270+ passing.
3. Commit and push to `main`.
4. Watch the deploy on Vercel dashboard → Deployments. Build takes ~30–60s.

Manual-trigger redeploy without a code change: Vercel dashboard → Deployments → latest → … menu → Redeploy. Useful after changing env vars.

## Checking logs

Vercel dashboard → the project → Logs tab. Filter by function `api/slack_events.py`. Every request logs at least one line; look for:

- `signature verification failed` — mismatched `SLACK_SIGNING_SECRET` or a replayed request.
- `url_verification challenge received` — one-time handshake when the Event Subscription URL is first saved. Good sign.
- `processing app_mention channel=... user=...` — the handler entered the app_mention branch. If you see this but no follow-up `slack.postMessage ok` or `handle_slack_event raised`, the invocation was likely killed by `maxDuration` mid-work. A `Connection refused` trace right after this line means the function couldn't reach Supabase — check that `SUPABASE_URL` in Vercel is the cloud URL, not `127.0.0.1:54321`.
- `skipping retry #N` — Slack retried (almost always because the first delivery took >3s on a cold start). The original invocation is still processing; this retry is acked fast and discarded.
- `slack.postMessage ok: ...` — Ella posted successfully.
- `slack.postMessage failed: ...` — full JSON body from Slack's Web API; check `error` field (`not_in_channel`, `missing_scope`, `channel_not_found`, etc.).
- `handle_slack_event raised: ...` — agent crash. Full traceback follows.

Cross-reference with `agent_runs` rows in Supabase Studio — every mention should have landed a row, whether the handler succeeded or the Slack post failed.

**Logger level gotcha.** Vercel's Python runtime pre-configures the root logger at `WARNING`. A naive `logging.basicConfig(level=INFO)` is a no-op because basicConfig doesn't override existing handlers, so your `logger.info(...)` lines get dropped silently. `api/slack_events.py` fixes this by calling `logging.getLogger().setLevel(logging.INFO)` at import time; any new module whose logs need to be visible in Vercel must do the same.

## Rolling back

Vercel dashboard → Deployments → find the last known-good deployment → … menu → Promote to Production. Takes a few seconds; no git changes needed.

If the bad code is already in `main`, follow the promotion with a `git revert` on the offending commit so the next push doesn't re-deploy it.

## Rotating the Slack signing secret

Slack's signing secret changes if someone regenerates it in the app console or if the app is reinstalled. When that happens:

1. api.slack.com/apps → the app → Basic Information → App Credentials → Signing Secret → copy the new value.
2. Update `.env.local` (for local dev / future harness runs).
3. Vercel dashboard → Project Settings → Environment Variables → edit `SLACK_SIGNING_SECRET` → paste new value → save.
4. Redeploy (env-var changes don't propagate without one — see "Redeploying" above).
5. Smoke test: @mention Ella in the Ella smoke-test channel. If the Vercel log shows `signature verification failed`, the old value is still cached — redeploy again or force-redeploy from the dashboard.

The same process applies to rotating `SLACK_BOT_TOKEN` (from OAuth & Permissions → Reinstall to Workspace).

## Rotating other secrets

Same pattern: update `.env.local` for parity, update Vercel env var, redeploy. `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` rotations are invisible to Slack — no smoke test needed beyond a single @mention round-trip.

## Adding a new pilot channel

V1 does not consult `slack_channels.ella_enabled` — the enabled-channel list is the set of channels the Slack app is installed in. To add a channel:

1. Invite the Ella bot to the new channel (`/invite @Ella`).
2. Verify / create the `slack_channels` row with the channel's `C...` id and `client_id` set to the pilot client's UUID. Reference `docs/archive/historical/ella-v1-scope.md` for how `client_id` drives retrieval scoping.
3. No code change; no redeploy needed.

## User-token posting (M1.4) — deploy + rollback

As of M1.4.3 (2026-04-27), `api/slack_events.py:_post_to_slack` uses a
two-token strategy: try `SLACK_USER_TOKEN` (the @ella user, posts with
no APP tag); on any failure (HTTP error, ok=false from Slack like
`missing_scope` / `not_in_channel` / `channel_not_found`, network
exception, JSON decode), fall back to `SLACK_BOT_TOKEN` (with APP
tag — pre-M1.4 behavior). Architecture spec + rationale in
`docs/archive/historical/ella_user_token.md`.

### Deploy a new SLACK_USER_TOKEN

The token is generated by the OAuth flow as the dedicated @ella
Slack user account. See `docs/archive/historical/ella_user_token.md` §
"Operational work" for the full setup sequence (create user account,
add as app Collaborator to clear the install gate, OAuth as Ella,
capture xoxp-).

To roll out the captured token to production:

1. Vercel dashboard → Project Settings → Environment Variables → add
   `SLACK_USER_TOKEN` with the `xoxp-...` value, scope **Production**.
2. Trigger a redeploy (any small push, OR Vercel dashboard →
   Deployments → latest → ⋯ → Redeploy without rebuild).
3. Smoke test in the Ella smoke-test channel: @-mention Ella; verify the
   reply renders as the @ella user (no APP tag); check Vercel
   function logs for `slack.postMessage ok via user-token`.
4. Per-channel rollout: invite the @ella user to each pilot channel
   that should get the user-token rendering.

### Operational rollback (~30 sec)

If anything goes wrong with user-token posting at scale:

1. Vercel dashboard → Project Settings → Environment Variables →
   delete `SLACK_USER_TOKEN`.
2. Trigger a redeploy.
3. The handler's `if user_token:` branch evaluates False, the
   user-path is skipped, posts revert to bot-token-only with the
   APP tag.

No code change required for rollback. Pinned by the unit test
`tests/api/test_slack_events_post.py::test_no_user_token_uses_bot_directly`.

### Per-channel verification

If Ella's user-token posting works in some channels but not others:
the @ella user account isn't a member of the misbehaving channel.
Symptoms: Vercel logs show `slack.postMessage user-token path
returned ok=false (slack_error=not_in_channel) — falling back to
bot-token`. Reply still lands (via fallback) but with the APP tag.

Fix: invite @ella to that channel via Slack's "Add people" UI.

## Known limits and gotchas

- **Every first-mention cold start will miss the 3s ack** — this is by design given the synchronous architecture. Slack retries; the retry branch acks in <1s and discards. User sees the reply ~5–10s after mentioning on cold start, ~3s on warm. If the perceived lag becomes a problem, enable Fluid Compute (project-level setting) and revert to the threaded pattern.
- **`maxDuration: 60` is a hard ceiling on the full synchronous handler.** If Ella's roundtrip exceeds it, the invocation is killed with no Slack post. Diagnose via `agent_runs` row (status `running`, `ended_at` null) + Vercel log showing invocation termination.
- **Posting errors are logged, not retried.** If `chat.postMessage` fails (transient Slack outage, missing scope, bot not in channel), the message is lost for that mention. Acceptable for V1; a retry queue belongs with eval / HITL work later.
- **No event-id deduplication.** If Slack delivers the same event twice via a path that doesn't set `X-Slack-Retry-Num` (shouldn't happen, but possible), we'd process it twice. Log it in `docs/archive/historical/future-ideas.md` if it surfaces.
- **Vercel env vars must match the target Supabase.** If `SUPABASE_URL` still points at `127.0.0.1:54321` (local dev), every mention fails at `_lookup_channel` with `httpx.ConnectError: [Errno 111] Connection refused` — Lambda has no route to your laptop's loopback. Smoke test caught this on 2026-04-23. Cloud Supabase push swaps both `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the cloud project's values.
