import type { Session, TurnModel } from '@wrenyard/session'
import type { AgentModelRoute } from './bot-agents/tools.mts'

/** The model-route source both the bot session tools and session.send share. */
export interface SessionModelRouteSource {
  selectModels(): Promise<readonly AgentModelRoute[]>
  isModelUsable(provider: string, model: string): boolean
}

/**
 * The model one send runs on. A session keeps its current model and effort
 * while that model is usable. A session without one, or whose model is now
 * excluded, exhausted or blocked, gets the first route of the system's
 * automatic selection, exactly as if a person switched the model before
 * sending; with no route the send fails. A running turn never switches model.
 */
export async function resolveSessionModel(
  sessions: Session,
  sessionId: string,
  deps: SessionModelRouteSource,
): Promise<AgentModelRoute> {
  const current = currentSessionModel(sessions, sessionId)
  if (current !== undefined && deps.isModelUsable(current.provider, current.model)) {
    return {
      provider: current.provider,
      model: current.model,
      reasoningEffort: current.reasoningEffort ?? 'high',
    }
  }

  const route = (await deps.selectModels())[0]
  if (route === undefined) throw new Error('no model available from automatic routing')
  return route
}

/** The model a session's newest started turn ran on, as `turn.started` recorded it. */
export function currentSessionModel(sessions: Session, sessionId: string): TurnModel | undefined {
  const events = sessions.readLedger(sessionId)
  const started = [...events].reverse().find(event => event.type === 'turn.started')
  if (started?.type !== 'turn.started') return undefined
  let model = `${started.model.provider}/${started.model.model}`
  for (const event of events) {
    if (event.turn === started.turn && event.type === 'span.finished' && event.kind === 'reasoning' && event.requestModel !== undefined) model = event.requestModel
  }
  const [provider, ...parts] = model.split('/')
  return {
    ...started.model,
    provider: provider!,
    model: parts.join('/'),
  }
}
