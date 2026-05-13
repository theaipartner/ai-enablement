// Slack `:shortcode:` → unicode emoji renderer.
//
// Slack's API delivers emojis as literal shortcode text in `event.text`
// (e.g. `:right-facing_fist:`) rather than as unicode (🤜). The Slack
// client renders shortcodes visually but the underlying API payload is
// the raw text, which lands in `slack_messages.text` and propagates
// through `agent_runs.input_summary` / `output_summary`.
//
// Two-pass lookup. Slack's shortcode convention is the Unicode CLDR
// short name with spaces → underscores and hyphens preserved — e.g.
// CLDR "right-facing fist" becomes Slack `:right-facing_fist:` and CLDR
// slug `right_facing_fist`. Some Slack shortcodes are aliases that
// don't match any CLDR slug (`:thumbsup:`, `:+1:`); those are covered
// by node-emoji's larger alias keyset. So:
//
//   1. `node-emoji` (handles aliases: :thumbsup:, :+1:, :smile:, etc.)
//   2. `unicode-emoji-json` (handles CLDR slugs via hyphen normalize)
//   3. pass-through (workspace custom emojis, unknown shortcodes)
//
// Both libs together cover ~98% of Slack emoji shortcodes seen in
// practice. Unknown shortcodes (custom workspace emojis like
// `:helios-logo:`) pass through unchanged — they can't be rendered to
// unicode anyway.

import { emojify, has as nodeEmojiHas } from 'node-emoji'
import unicodeEmojiData from 'unicode-emoji-json'

// Build the CLDR-slug → unicode reverse map once at module load.
type EmojiEntry = { slug: string }
const slugToUnicode = new Map<string, string>()
for (const [unicode, meta] of Object.entries(
  unicodeEmojiData as Record<string, EmojiEntry>,
)) {
  if (meta.slug) slugToUnicode.set(meta.slug, unicode)
}

// Slack shortcodes are case-insensitive, alphanumerics + `_` `-` `+`.
// The `+` covers `:+1:` / `:-1:`; the `-` covers `:right-facing_fist:`.
const SHORTCODE_REGEX = /:([a-z0-9_+\-]+):/gi

/**
 * Replace `:shortcode:` patterns in `text` with their unicode emoji
 * equivalents. Unknown shortcodes pass through unchanged. Empty / null
 * input returns as-is.
 */
export function renderEmojis(text: string): string {
  if (!text) return text
  return text.replace(SHORTCODE_REGEX, (match, name: string) => {
    const lower = name.toLowerCase()
    // 1. node-emoji pass — covers aliases (:thumbsup:, :+1:, :smile:).
    if (nodeEmojiHas(lower)) {
      const expanded = emojify(`:${lower}:`)
      if (expanded !== `:${lower}:`) return expanded
    }
    // 2. CLDR slug pass — normalize Slack's `-` to `_` and look up.
    //    e.g. Slack `right-facing_fist` → CLDR slug `right_facing_fist`.
    const normalized = lower.replace(/-/g, '_')
    const unicode = slugToUnicode.get(normalized)
    if (unicode) return unicode
    // 3. Pass-through unknown / custom workspace emojis.
    return match
  })
}
