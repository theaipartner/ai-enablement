// Shared Slack `<@U...>` mention renderer.
//
// Slack's API ships text with mentions in the form `<@U0XXXXX>` (or
// `<@W0XXXXX>` for Slack Connect / Enterprise grid). We render them as
// readable `@First Last` in the dashboard by looking up the user ID
// against the `clients` + `team_members` tables.
//
// Pure-function transform layer: callers (any surface that renders
// Slack text with mentions) build the U-ID → display-name map once per
// request and pass it in. The lookup helpers live wherever the calling
// surface keeps its DB code.

// Slack user IDs start with U (regular users) or W (workspace-grid /
// Slack Connect). Both can appear in `<@...>` mention syntax.
const MENTION_REGEX = /<@([UW][A-Z0-9]+)>/g

/**
 * Replace every `<@U...>` / `<@W...>` mention in `text` with
 * `@{full_name}` for IDs present in `nameMap`. Unresolvable IDs are
 * left in their raw `<@U...>` form — don't strip on miss, the syntax
 * is more useful than silent loss.
 */
export function renderMentions(
  text: string,
  nameMap: Map<string, string>,
): string {
  if (!text) return text
  return text.replace(MENTION_REGEX, (full, uid: string) => {
    const name = nameMap.get(uid)
    return name ? `@${name}` : full
  })
}

/**
 * Extract every Slack user ID referenced via `<@...>` mention syntax
 * across a list of text bodies. Returns a deduped Set. Callers feed
 * this into a batched `clients` + `team_members` DB query to build
 * the name map that `renderMentions` consumes.
 */
export function collectMentionedUserIds(
  texts: ReadonlyArray<string | null | undefined>,
): Set<string> {
  const ids = new Set<string>()
  for (const text of texts) {
    if (!text) continue
    // Reset the regex's lastIndex between texts since it's `/g`.
    MENTION_REGEX.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = MENTION_REGEX.exec(text)) !== null) {
      ids.add(match[1])
    }
  }
  return ids
}
