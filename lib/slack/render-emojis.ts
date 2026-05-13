// Slack `:shortcode:` → unicode emoji renderer.
//
// Slack's API delivers emojis as literal shortcode text in `event.text`
// (e.g. `:right-facing_fist:`) rather than as unicode (🤜). The Slack
// client renders shortcodes visually but the underlying API payload is
// the raw text, which lands in `slack_messages.text` and propagates
// through `agent_runs.input_summary` / `output_summary`. Dashboard
// surfaces consuming any of these need a render-time transform.
//
// Built on `node-emoji` (a regular dependency installed for this
// purpose). Covers the standard Unicode emoji set; Slack's custom
// workspace emoji (`:helios-logo:`) are unsupported by the library
// and pass through unchanged. That's the right behavior — custom
// emojis can't be rendered to unicode anyway.
//
// Used by `lib/db/ella-runs.ts` for every text field surfaced on the
// list (output_text) and detail (input_summary, output_summary,
// slack_response_text, haiku_reasoning, surrounding-message text)
// pages. Applied alongside `renderMentions` so each text field gets
// both mention + emoji transforms.

import { emojify } from 'node-emoji'

/**
 * Replace `:shortcode:` patterns in `text` with their unicode emoji
 * equivalents. Unknown shortcodes pass through unchanged. Empty / null
 * input returns as-is.
 *
 * `emoji.emojify` from node-emoji handles the transform, including
 * variations like `:thumbsup:` / `:+1:` aliases. The fallback option
 * keeps unknown shortcodes (e.g. workspace-custom Slack emojis) in
 * their raw `:name:` form rather than stripping them.
 */
export function renderEmojis(text: string): string {
  if (!text) return text
  return emojify(text, {
    fallback: (name: string) => `:${name}:`,
  })
}
