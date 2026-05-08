# Architecture: Ella User-Token Posting (M1.4)

Discovery output for converting Ella from bot-token-posting (`xoxb-`,
shows the "APP" tag) to user-token-posting (`xoxp-`, posts as a regular
Slack user with no APP tag). Becomes the spec M1.4.3 implements against.

**Status:** discovery complete (M1.4.1, 2026-04-27). Live testing required
before commit on a few items — flagged inline as `[VERIFY]`.

**Source priority used:** Slack canonical docs at `docs.slack.dev` and
`api.slack.com` first; corroborating tutorials only as a sanity check.

---

## What's actually changing

The conversion is narrower than it sounds at first. Only **one** code
path is affected: `api/slack_events.py:_post_to_slack()`, which calls
`chat.postMessage` to deliver Ella's reply. Everything else stays
bot-token:

- `ingestion/slack/client.py` — pure data ingestion (`conversations.*`,
  `users.*`). No user-visible posts. Bot token is correct.
- `api/slack_events.py:do_POST()` — receives Slack's signed webhook for
  `app_mention` events. The Events API delivers to the *app*, not the
  user. Signature verification uses `SLACK_SIGNING_SECRET`, independent
  of bot/user token choice. **No change.**
- `agents/ella/*`, `shared/*` — agent logic, retrieval, formatting. No
  Slack-API calls. **No change.**

So the migration is one function (`_post_to_slack`) plus operational
work (create Ella user account, OAuth, add to channels).

## How user vs bot rendering differs (the original ask)

Per Slack's chat.postMessage docs:
- **Bot token (`xoxb-`)** → message renders with the bot's display name
  + the "APP" tag visible in every Slack client. This is what Nabeel
  flagged as unprofessional.
- **User token (`xoxp-`)** → message renders as a regular user message
  under that user's name + avatar, no APP tag. Indistinguishable from
  a human-typed message in every client.

The historical `as_user=true` parameter that used to flip a bot's
output to user-style is **classic-apps-only** in 2026 ("does not
function with workspace apps"). The modern path is to call
`chat.postMessage` with the user's xoxp- token directly — the token
type itself determines whose voice the message uses.

`[VERIFY]` Confirm rendering by smoke-testing in `#ella-test-drakeonly`
before flipping pilot channels.

## OAuth flow — single app, two tokens

Slack's OAuth v2 supports requesting bot and user scopes in one flow.
The token-exchange response returns BOTH:

```
GET https://slack.com/oauth/v2/authorize
    ?client_id=<APP_CLIENT_ID>
    &scope=app_mentions:read,chat:write,channels:history,...   # bot scopes (current)
    &user_scope=chat:write                                     # NEW user scope
    &redirect_uri=<callback>

# After Drake authorizes, Slack POSTs `code` to the callback. Exchange:
POST https://slack.com/api/oauth.v2.access
  -F code=<CODE> -F client_id=<...> -F client_secret=<...>

# Response (verbatim shape from docs):
{
  "ok": true,
  "access_token": "xoxb-...",                  # bot token (top-level)
  "token_type": "bot",
  "scope": "app_mentions:read,chat:write,...",
  "bot_user_id": "U0KRQLJ9H",
  "team": { "name": "...", "id": "T..." },
  "authed_user": {
    "id": "U1234",
    "scope": "chat:write",
    "access_token": "xoxp-...",                # user token (nested)
    "token_type": "user"
  }
}
```

We extract the nested `authed_user.access_token` and store it as a new
Vercel env var `SLACK_USER_TOKEN`. Bot token stays at `SLACK_BOT_TOKEN`
unchanged.

**Token expiry:** "OAuth tokens do not expire by default; they must be
revoked explicitly via auth.revoke." Token rotation is opt-in and
adds complexity (refresh-token storage in a serverless context).
**Don't enable rotation for V1** — stable env-var pattern works.

**Scope conflict caveat:** Sign-in-with-Slack (SIWS) user scopes can't
combine with non-SIWS user scopes in the same flow. `chat:write` is
non-SIWS, so this doesn't bite us — but means we can't add SIWS later
without a separate OAuth flow.

## What scope is needed for posting

Just **`chat:write`** as a `user_scope`. Confirmed in the
chat.postMessage docs:

> "Bot token: `chat:write`. User token: `chat:write`."

Same scope name on both token types; different effect because the
token determines the actor.

If we ever need to post in public channels Ella's user account isn't
a member of: add `chat:write.public`. We don't need this for V1
because Drake will explicitly invite Ella to each pilot channel.

We do NOT need `chat:write.customize` (that's for `username`/`icon_url`
overrides — irrelevant; the user account IS Ella, no override needed).

## Operational work — create the Ella user account

Three steps for Drake / the workspace admin:

### 1. Create the user account

Workspace admin → invite a new member with email `ella@theaipartner.io`
(or similar dedicated address Drake controls). On Slack Pro plan, this
is **+1 paid seat (~$7.25/mo)** because Pro charges per active member.
Free plan supports user accounts but has 90-day message retention.

`[VERIFY]` Confirm Drake's current plan tier — affects (a) seat cost,
(b) admin's ability to bulk-add Ella to channels (Business+ has more
admin tooling).

**Display name + handle:** `[VERIFY]` decision needed. Three reasonable
options:
- `Ella` + `@ella` — cleanest visually, but ambiguous if a human named
  Ella ever joins
- `Ella` + `@ella-aip` — distinct handle, less likely to collide
- `Ella (AI)` + `@ella-aip` — explicit AI disclosure in display name
  (recommended — see "Slack policy" below)

### 2. OAuth as Ella

Log in to Slack as the Ella user account, navigate to the existing
Slack app's OAuth install URL with `user_scope=chat:write` added. Slack
shows a consent screen asking Ella to authorize the app to post on her
behalf. Approve. The OAuth callback receives the code; manual exchange
via curl yields the `xoxp-` user token. Capture immediately, paste
into Vercel env as `SLACK_USER_TOKEN`.

**Why OAuth as Ella, not as Drake:** the user token is permanently
tied to whichever account did the OAuth. If Drake ever leaves or his
account is deactivated, his user token revokes. Better to bind the
token to a dedicated automation account that exists for this purpose.

### 2a. Collaborator workaround (surfaced at M1.4.2)

When Ella first attempted the install URL, Slack rejected with:
*"Contact a member of your team who is a Collaborator of this app
and they can add you."* The "Reinstall to Workspace" path on
api.slack.com is collaborator-gated for non-distributed apps —
Ella isn't an app collaborator by default.

**Fix:** in admin browser, api.slack.com → Settings → Collaborators
→ Add Collaborators → search Ella → confirm. Ella can then run the
install. Optional cleanup after the OAuth completes: remove Ella as
a Collaborator (the token persists past collaborator status — it's
bound to the consent grant). Tightens least-privilege; not required.

This will hit again on every future re-install (e.g., scope changes,
secret rotation). Documented in `docs/known-issues.md` §
"Fathom webhook registration UI viewport bug" — same pattern in a
different vendor; same lesson (provider UIs are friction surfaces
that re-bite on every re-auth).

### 3. Add Ella to pilot channels

The Ella user account needs to be added to each of the 7 pilot client
channels (and `#ella-test-drakeonly`, `#ella-test`). The bot user
remains in those channels too — events still flow through the bot side
of the app.

Per Slack's docs, adding members to channels:
- Public channel: any current member can invite, or workspace admin
  bulk-add via channel settings
- Private channel: any current member can invite. **Business+ tier
  adds an admin-driven bulk-invite path.** On Pro tier, Drake adds
  Ella per-channel via the channel's "Add people" UI (~30 sec each).

`[VERIFY]` Drake confirm the 7 pilot channels are in the AI Partner
workspace (not a client-owned workspace) — this whole architecture
assumes the AI Partner workspace owns the channels.

## Failure modes + risk surface

| Risk | Likelihood | Mitigation |
|---|---|---|
| New-account first-send throttling — Slack may rate-limit Ella's first messages while account "warms up" | Medium | Smoke-test in `#ella-test-drakeonly` before flipping pilot channels. Several test posts over an hour to clear any throttle. |
| Pro tier doesn't support some feature we need | Low | Verify before committing. Pro likely sufficient — $7.25/seat doesn't gate user-token API access per docs. |
| User token rotation gets enabled accidentally | Low | Don't toggle rotation in app config. Document "leave off" in runbook. |
| Drake's account being the OAuth'er instead of Ella's | Medium if not careful | Spec calls for OAuth as Ella explicitly. Discipline matters at deploy time. |
| Rate limits exceeded — bot + user share the per-app pool | Very low | Pilot volume is <5 msg/min. Slack's docs say "1 msg/sec/channel + several hundred msgs/min/workspace." |
| Slack's developer policy on AI / impersonation flags this | Low if disclosed | See "Slack policy" below — disclose clearly. |
| Existing `#ella-test-drakeonly` history stays attributed to bot | Certain | No retroactive re-attribution. Cutover produces a history split (bot before, user after). Acceptable. |
| Cutover breaks something we didn't anticipate | Medium | Keep `SLACK_BOT_TOKEN` env var live; conditional in `_post_to_slack` to fall back if the user-token path fails. Rollback = flip an env var, redeploy. |

## Post-deploy observation: the mention-target asymmetry (M1.4.3)

After M1.4.3 deployed and smoke-tested in `#ella-test-drakeonly`,
Drake observed: Ella's *replies* render as the @ella user (no APP tag,
exactly as designed) — but the *@-mention used to invoke her* still
targets the bot account (which displays "APP" next to the bot's name
in the mention itself). Two distinct surfaces:

- **Reply rendering** (the message content) — comes from
  `chat.postMessage`, controlled by which token the handler uses.
  M1.4.3 made this `xoxp-` → no APP tag. ✅ Solved.
- **Mention target** (the `@<who>` someone types or autocompletes
  to invoke Ella) — comes from Slack's Events API subscription.
  `app_mention` events are bound to the bot user; that's a Slack
  architectural constraint. Mentioning the @ella user account
  doesn't fire any event our handler subscribes to. So users still
  type `@<bot-name>` to wake Ella, and Slack renders that mention
  with the bot's "APP" tag.

Whether this fully addresses Nabeel's "looks unprofessional" feedback
is open as of 2026-04-27 close-out. M1.4.5 (pilot rollout) holds
until Nabeel's read comes back. Possible next-steps if the mention
asymmetry isn't acceptable:

- Switch Ella's invocation surface entirely (slash command — no
  bot user appearance, but loses thread context)
- Subscribe to plain `message.channels` events and filter for `@ella`
  user mentions (works but: every message in every pilot channel hits
  our endpoint, and Ella has to be a workspace member of each — already
  true)
- Accept the asymmetry; document it as a known visual quirk of
  Slack's bot-vs-user model

No code change today. Decision lives with Drake + Nabeel feedback.

## Slack policy on AI / impersonation

Slack's App Developer Policy:
> "Applications must not allow impersonation of Users or otherwise
> allow for false representations within the Application."

**This applies to impersonating a HUMAN user without their consent.**
A dedicated "Ella" user account that exists for AI automation, with
the workspace admin's full knowledge and the OAuth flow's explicit
consent, is not impersonation in the policy's intent. It's a non-human
member of the workspace — same pattern as countless team automation
accounts (Zapier, n8n, internal scripts) that have existed in Slack
workspaces for a decade.

**Disclosure recommendation:** make Ella's AI nature visible in her
display name. `Ella (AI)` or `Ella — AI assistant` in the display
name field, regardless of the handle. If a client ever asks "wait,
am I talking to a person or a bot?", the answer is a glance at the
display name. Drake announced Ella to pilot clients as an AI assistant
in the original rollout, so this is consistent.

If Slack ever flags the account, the rollback path is rapid: revoke
the user token, switch the handler back to bot-token-posting, accept
the APP tag. Recovery cost: ~10 minutes.

## Implementation shape (M1.4.3)

Changes to `api/slack_events.py:_post_to_slack`:

```python
def _post_to_slack(*, channel: str, text: str, thread_ts: str | None) -> None:
    # Prefer user token (no APP tag); fall back to bot token if user
    # token is missing or its API call fails. Fallback exists so a
    # mistakenly-deleted env var doesn't take Ella offline.
    user_token = os.environ.get("SLACK_USER_TOKEN")
    bot_token = os.environ.get("SLACK_BOT_TOKEN")
    token = user_token or bot_token
    if not token:
        raise RuntimeError("Neither SLACK_USER_TOKEN nor SLACK_BOT_TOKEN set")
    # ... existing post logic, with `Authorization: Bearer {token}` ...
```

That's the entire code change. Five lines of logic, plus the env var
addition. No new files, no schema changes, no migration.

`vercel.json` — no change. Same function, same handler.

`.env.example` — add `SLACK_USER_TOKEN` with rotation/setup notes.

`docs/runbooks/slack_webhook.md` — add a "User token rotation /
revocation" section since the new env var has its own ops surface.

## Open questions (need Drake's input before M1.4.2 setup)

1. **Workspace plan tier?** (Free / Pro / Business+) Affects seat cost,
   admin tools for bulk channel invites, and certain user-token
   features. Pro is sufficient for our needs but worth confirming.
2. **Ella's user handle?** `@ella`, `@ella-aip`, `@ella-ai-assistant`,
   etc. The display name should include "(AI)" or similar regardless;
   handle choice is mostly aesthetic but should avoid future
   collisions.
3. **OAuth as Ella vs Drake?** Recommendation: as Ella (dedicated
   account, future-safe). Slight extra setup (create the account
   first, log in as Ella to authorize). Worth confirming Drake agrees
   with the "future-safe" framing.
4. **Keep bot-token fallback?** Recommended yes — accidental env-var
   deletion shouldn't take Ella offline. Adds ~3 lines of code.
5. **Cost: $7.25/mo for one extra Slack seat — is the APP-tag removal
   worth that recurring cost?** Drake's call. Pilot is the trial period.

## Implementation timeline estimate

This is a **1.5-2 day project**, not a 1-day cutover, due to the
operational steps:

- **M1.4.2 (setup, ~2 hours over a workday):** create Ella user
  account, OAuth flow, capture xoxp- token, set env var, add Ella to
  the 9 channels (7 pilot + 2 test).
- **M1.4.3 (code, <1 hour):** `_post_to_slack` env-var swap + fallback
  + smoke test locally.
- **M1.4.4 (deploy + verify, ~2 hours):** push, redeploy, manually
  trigger an Ella mention in `#ella-test-drakeonly`, observe the
  rendered message has no APP tag.
- **M1.4.5 (pilot rollout, ~1 hour):** mention Ella once per pilot
  channel as a smoke test. Pilots get the un-tagged voice from this
  point forward.

Spread over 1-2 days because the OAuth flow + channel adds need to
happen in real-time-with-Slack-UI, and the smoke test wants a few
hours of warm-up to flush any new-account throttling.

## Deploy + smoke-test runbook (M1.4.4)

The code change is uncommitted-but-tested as of M1.4.3. To finish the
rollout:

### 1. Push the M1.4.3 commit

`git push origin main`. Vercel auto-builds in ~60–90s. Both endpoints
should respond:

```bash
curl -i https://ai-enablement-sigma.vercel.app/api/slack_events
# Expect: HTTP 200
```

The new env var `SLACK_USER_TOKEN` (set in M1.4.2) is now picked up
by the running deployment.

### 2. Smoke test in `#ella-test-drakeonly` (the only channel where
Ella the user is currently a member, per M1.4.2 setup state)

@-mention Ella with a question that produces a typical reply. Two
visual signals to look for:

- **Display name:** the message header should show **Ella** (the user's
  display name) — not "Ella APP" or any APP tag.
- **Avatar:** Ella's user avatar (set in Slack profile) — not the
  generic app icon.
- **Hover/profile-card:** clicking the message author should open
  Ella's user profile, not the bot's app card.

### 3. Failure-mode verification

Test the fallback by intentionally breaking the user path. Easiest
path: temporarily uninvite Ella the user from `#ella-test-drakeonly`
(leaving the bot user in place). @-mention. Expected behavior:
- User-path attempt → Slack returns `not_in_channel` → fall through
  to bot.
- Reply lands as the bot (with APP tag).
- Vercel logs show:
  - `slack.postMessage user-token path returned ok=false (slack_error=not_in_channel) — falling back to bot-token`
  - `slack.postMessage ok via bot-token: ...`

Re-invite Ella to clean up.

### 4. Pilot rollout (M1.4.5)

Once the smoke test passes, add the Ella user account to each of the
6 remaining pilot channels (Fernando G, Musa, Jenny, Dhamen, Trevor,
Art). The bot user is already in those channels — just add the Ella
user. Each pilot's next coaching-call follow-up @-mention will
automatically use the user-token path.

### 5. Operational rollback

If anything goes wrong at scale, rollback is a 30-second operation:
1. Vercel dashboard → Project Settings → Environment Variables
2. Delete `SLACK_USER_TOKEN`
3. Redeploy (or any small push)

The handler's user-path branch becomes a no-op when the env var is
absent (`if user_token:` evaluates False); posts revert to bot-only.
No code change needed for rollback. The test
`test_no_user_token_uses_bot_directly` pins this behavior.

## Recommendation

**Do it.** The change is well-scoped, the Slack-side mechanics are
documented and clean, and the rollback story is fast (env var flip).
The cost is one Slack seat ($7.25/mo) plus 2 hours of Drake's time.

The only thing that gives me pause is the AI/impersonation policy —
not because I think it'll be flagged (the dedicated-AI-user-account
pattern is industry-standard) but because if Slack ever changes
position on it, we'd need to revert. Mitigation: keep the bot-token
path warm as a permanent fallback in code. Cost: 3 extra lines.

Sources used in this discovery:
- [Slack Tokens reference](https://docs.slack.dev/authentication/tokens/)
- [Installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/)
- [chat.postMessage method](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [Slack App Developer Policy](https://api.slack.com/developer-policy)
- [Add people to a channel](https://slack.com/help/articles/201980108)
- [Slack pricing](https://slack.com/pricing)
