/**
 * Shared group conversation.
 *
 * Bots and the user share one transcript. This module owns the wire type of a
 * transcript entry, the stable source key that makes a bot reply publish
 * exactly once, the mention rules, and the guidance every bot is given about
 * the group. It holds no daemon state and imports no Desktop code, so the
 * kernel and the protocol layer can share the same rules.
 */

/** One entry of the shared group transcript, as Desktop reads it. */
export interface GroupMessage {
  /** Monotonic transcript sequence, starting at 1. */
  seq: number
  /** ISO 8601 time the entry was published. */
  at: string
  author: 'user' | 'bot'
  /** Present on bot entries: the bot that spoke. */
  botId?: string
  /** Present on bot entries: the bot's display name at publish time. */
  name?: string
  text: string
}

/**
 * The stable dedup key of one bot ledger reply: the context session and the
 * ledger event sequence it came from. A replayed ledger can never publish the
 * same reply twice.
 */
export function groupSourceKey(sessionId: string, seq: number): string {
  return `${sessionId}:${seq}`
}

/** One bot as mention resolution sees it. Only enabled bots are addressable. */
export interface GroupBot {
  id: string
  name: string
  enabled: boolean
}

/**
 * What every bot is told about the group. Replies and questions land in the
 * shared transcript, and a peer is addressed with `@id` or `@name`.
 */
export const GROUP_PROMPT_GUIDANCE = [
  'You are in a shared group conversation with the user and every other bot.',
  'Every reply you send and every question you ask is visible to the whole group, not only to the person who woke you.',
  'Address another bot in your reply with @id or @name; that bot is woken with your message.',
  'Mention one bot once, and never mention yourself.',
].join(' ')

/**
 * Characters that continue an alias on either side. Latin letters, every
 * decimal digit, `_` and `-` continue a name; CJK, other scripts, whitespace,
 * and punctuation delimit it, so `请@pm，` addresses `pm` while `@pmx` does not.
 */
const ALIAS_CONTINUATION = /[\p{Script=Latin}\p{N}_-]/u

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function continuesAlias(char: string | undefined): boolean {
  return char !== undefined && ALIAS_CONTINUATION.test(char)
}

interface Alias {
  text: string
  botId?: string
  /** Id aliases resolve before display names at equal length. */
  order: number
  pattern: RegExp
}

function aliasOf(text: string, botId: string | undefined, order: number): Alias {
  return {
    text,
    botId,
    order,
    // Escaped, case-insensitive and Unicode aware: the alias must end at a
    // delimiter rather than inside a longer word.
    pattern: new RegExp(`^${escapeRegExp(text)}(?![\\p{Script=Latin}\\p{N}_-])`, 'iu'),
  }
}

/**
 * Build the resolvable aliases of one roster: bot ids first, then unique
 * display names. A display name shared by more than one enabled bot is left
 * out on purpose; its bots stay reachable by id and no mention silently picks
 * one of them. Sorting longest first makes `@design-auditor` beat `@design`.
 */
function aliasesOf(roster: readonly GroupBot[]): Alias[] {
  const enabled = roster.filter(bot => bot.enabled && bot.id !== '')
  const nameCounts = new Map<string, number>()
  for (const bot of enabled) {
    const name = bot.name.trim()
    if (name === '') continue
    const key = name.toLowerCase()
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
  }
  const aliases = new Map<string, Alias>()
  const add = (text: string, botId: string, order: number): void => {
    const alias = text.trim()
    if (alias === '') return
    const key = alias.toLowerCase()
    if (aliases.has(key)) return
    if (order !== 0 && (nameCounts.get(key) ?? 0) > 1) return
    aliases.set(key, aliasOf(alias, botId, order))
  }
  for (const bot of enabled) add(bot.id, bot.id, 0)
  for (const bot of enabled) add(bot.name, bot.id, 1)
  return [...aliases.values()].sort((left, right) =>
    right.text.length - left.text.length
    || left.order - right.order
    || left.text.localeCompare(right.text))
}

/**
 * Resolve every `@alias` of one text against the enabled roster, in the order
 * the mentions appear. Ids are tried before display names, aliases resolve
 * longest first, duplicates collapse, and `selfId` is dropped so a bot never
 * wakes itself by naming itself in its own reply.
 */
export function parseMentions(
  text: string,
  roster: readonly GroupBot[],
  options: { selfId?: string } = {},
): string[] {
  const aliases = aliasesOf(roster)
  if (aliases.length === 0) return []
  const resolved: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '@') continue
    if (continuesAlias(index === 0 ? undefined : text[index - 1])) continue
    const rest = text.slice(index + 1)
    const alias = aliases.find(candidate => candidate.pattern.test(rest))
    if (alias === undefined) continue
    // Move past `@` and the alias; the loop then moves past its delimiter.
    index += alias.text.length
    if (alias.botId === undefined) continue
    if (alias.botId === options.selfId) continue
    if (seen.has(alias.botId)) continue
    seen.add(alias.botId)
    resolved.push(alias.botId)
  }
  return resolved
}
