/**
 * Pure item state machine for Bot mode.
 *
 * This module holds every rule about which item lifecycle moves are legal and
 * which states own the project delivery lane. It performs no I/O and holds no
 * state: the bot host and the bot store call these functions before writing a
 * durable row, so an illegal transition is a thrown error instead of a
 * corrupted item.
 *
 * The literal lists here are the canonical definition; the runtime JSON schema
 * in `protocol/methods/bot.mts` mirrors them for the wire surface.
 */

/** Every state an inbox item can be in. */
export type BotItemState =
  | 'discovered'
  | 'verifying'
  | 'verified'
  | 'dispatched'
  | 'in_progress'
  | 'ready'
  | 'accepting'
  | 'accepted'
  | 'rejected'
  | 'merging'
  | 'merged'
  | 'completing'
  | 'completed'
  | 'dismissed'
  | 'parked'
  | 'failed'
  | 'withdrawn'

export const BOT_ITEM_STATES = [
  'discovered',
  'verifying',
  'verified',
  'dispatched',
  'in_progress',
  'ready',
  'accepting',
  'accepted',
  'rejected',
  'merging',
  'merged',
  'completing',
  'completed',
  'dismissed',
  'parked',
  'failed',
  'withdrawn',
] as const satisfies readonly BotItemState[]

/**
 * Steps the journal knows. Every outward side effect is one of these named
 * steps; a kind with no registered handler is logged as unavailable and the
 * item is left in place.
 */
export type BotStepKind =
  | 'verify'
  | 'review'
  // The explicit `ready -> accepting` lane-acquire step: it performs no outward
  // effect of its own; the store acquires the project's delivery lane when the
  // state is written, and a busy lane leaves the item in `ready`.
  | 'lane.acquire'
  | 'worktree.create'
  | 'session.create'
  | 'session.send'
  | 'rebase'
  | 'accept'
  | 'merge'
  | 'push'
  | 'inbox.poll'
  | 'inbox.get'
  | 'inbox.complete'
  | 'annotate'
  | 'release'
  | 'notify'

/** Journal status of one step attempt. */
export type BotStepStatus = 'pending' | 'done' | 'failed' | 'unknown'

export const BOT_STEP_STATUSES = ['pending', 'done', 'failed', 'unknown'] as const satisfies readonly BotStepStatus[]

/**
 * States from which an item can never move again on its own: `completed` work
 * is delivered, `dismissed` work was not real, and `withdrawn` sources
 * disappeared mid-flight. `failed` is deliberately absent — it is terminal
 * until an explicit manual retry returns it to `discovered`.
 */
export const TERMINAL_ITEM_STATES = ['completed', 'dismissed', 'withdrawn'] as const satisfies readonly BotItemState[]

/**
 * The delivery-lane range: from the moment an item starts acceptance until it
 * finishes completing, it owns its project's lane, so one project merges and
 * pushes one item at a time. Every other state leaves the lane free.
 */
export const LANE_ITEM_STATES = [
  'accepting',
  'accepted',
  'rejected',
  'merging',
  'merged',
  'completing',
] as const satisfies readonly BotItemState[]

/**
 * The allowed forward moves. Any non-terminal state may additionally park,
 * fail or withdraw; that common rule is already written into each row. A
 * `parked` item returns to its `parkedFrom` (see {@link canTransition}), and a
 * `failed` item moves only by an explicit manual retry.
 */
const TRANSITIONS: Record<BotItemState, readonly BotItemState[]> = {
  discovered: ['verifying', 'parked', 'failed', 'withdrawn'],
  verifying: ['verified', 'dismissed', 'parked', 'failed', 'withdrawn'],
  verified: ['dispatched', 'parked', 'failed', 'withdrawn'],
  dispatched: ['in_progress', 'parked', 'failed', 'withdrawn'],
  in_progress: ['ready', 'parked', 'failed', 'withdrawn'],
  ready: ['accepting', 'parked', 'failed', 'withdrawn'],
  accepting: ['accepted', 'rejected', 'parked', 'failed', 'withdrawn'],
  accepted: ['merging', 'parked', 'failed', 'withdrawn'],
  rejected: ['in_progress', 'parked', 'failed', 'withdrawn'],
  merging: ['merged', 'parked', 'failed', 'withdrawn'],
  merged: ['completing', 'parked', 'failed', 'withdrawn'],
  completing: ['completed', 'parked', 'failed', 'withdrawn'],
  completed: [],
  dismissed: [],
  parked: ['dismissed', 'failed', 'withdrawn'],
  failed: ['discovered'],
  withdrawn: [],
}

/** True when an item in this state can never move again without a retry. */
export function isTerminalItemState(state: BotItemState): boolean {
  return (TERMINAL_ITEM_STATES as readonly BotItemState[]).includes(state)
}

/** True while this state owns its project's delivery lane. */
export function requiresDeliveryLane(state: BotItemState): boolean {
  return (LANE_ITEM_STATES as readonly BotItemState[]).includes(state)
}

export interface TransitionOptions {
  /**
   * The state a parked item was parked from. A parked item may only resume into
   * that state (or be dismissed / failed / withdrawn outright).
   */
  parkedFrom?: BotItemState
}

/** True when `from -> to` is a legal item transition. */
export function canTransition(from: BotItemState, to: BotItemState, options: TransitionOptions = {}): boolean {
  if (isTerminalItemState(from)) return false
  if (from === 'parked') {
    if (to === 'dismissed' || to === 'failed' || to === 'withdrawn') return true
    return options.parkedFrom === to
  }
  return TRANSITIONS[from].includes(to)
}

/**
 * Validate one item transition, throwing on an illegal one. Callers use this
 * immediately before persisting the new state, so an illegal move is reported
 * as an error rather than silently stored.
 */
export function assertItemTransition(from: BotItemState, to: BotItemState, options: TransitionOptions = {}): void {
  if (canTransition(from, to, options)) return
  throw new Error(`illegal bot item transition: ${from} -> ${to}`)
}
