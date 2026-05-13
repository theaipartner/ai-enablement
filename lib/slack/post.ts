// Thin Slack chat.postMessage helper for TypeScript surfaces (Next.js
// server actions). TS-side mirror of shared/slack_post.py — the Python
// helper Ella's webhook handler uses. Both do a direct POST to
// https://slack.com/api/chat.postMessage using SLACK_BOT_TOKEN; no
// @slack/web-api client library involved. Keeps both languages doing
// the same minimal thing.
//
// Why a second file (not reusing the Python one): the Python helper
// lives in `shared/` and is consumed by api/*.py serverless functions.
// Next.js server actions run in the Node runtime; calling out to Python
// would add a cross-language hop. The minimal direct-POST approach is
// ~30 lines either way, so duplication is cheap and the two helpers
// stay structurally identical.
//
// Surface: a single `postMessage(channelId, text)` helper. No threading,
// no blocks, no retries. Add knobs only when a caller needs them.

const SLACK_POST_TIMEOUT_MS = 5_000

export type SlackPostResult =
  | { ok: true; slackError: null }
  | { ok: false; slackError: string }

export async function postMessage(
  channelId: string,
  text: string,
): Promise<SlackPostResult> {
  const botToken = process.env.SLACK_BOT_TOKEN
  if (!botToken) {
    return { ok: false, slackError: 'missing_bot_token' }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SLACK_POST_TIMEOUT_MS)
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: channelId, text, mrkdwn: true }),
      signal: controller.signal,
    })
    if (!res.ok) {
      return { ok: false, slackError: `http_${res.status}` }
    }
    const parsed = (await res.json()) as { ok?: boolean; error?: string }
    if (parsed.ok) {
      return { ok: true, slackError: null }
    }
    return { ok: false, slackError: parsed.error ?? 'unknown_error' }
  } catch (err) {
    const name = err instanceof Error ? err.name : 'UnknownError'
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, slackError: `${name}: ${message}` }
  } finally {
    clearTimeout(timeout)
  }
}
