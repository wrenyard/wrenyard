import { INVALID_PARAMS, ProtocolError } from '../../protocol/errors.mts'
import type { BotHost } from '../../daemon/services/bot/host.mts'
import type { RpcRouter } from '../rpc-router.mts'

export interface BotRpcHandlerOptions {
  host: BotHost
}

/**
 * Register the `bot.*` IPC surface over the injected bot host. Every method is
 * available over the owner IPC transport only: a session transport (or any
 * other) is rejected with `bot_forbidden`, so a session can never control a bot.
 */
export function registerBotHandlers(router: RpcRouter, options: BotRpcHandlerOptions): void {
  const host = options.host
  const call = async <T,>(context: unknown, method: string, operation: () => T | Promise<T>): Promise<T> => {
    const transport = context && typeof context === 'object' && 'transport' in context
      ? (context as { transport?: unknown }).transport : undefined
    if (transport !== 'ipc') {
      throw new ProtocolError(
        { code: INVALID_PARAMS.code, message: `${method} is only available over local IPC` },
        { code: 'bot_forbidden', statusCode: 403, transport: typeof transport === 'string' ? transport : 'unknown' },
      )
    }
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError({
        code: INVALID_PARAMS.code,
        message: error instanceof Error ? error.message : 'Bot request rejected',
      })
    }
  }

  router.register('bot.list', (_params, _message, context) =>
    call(context, 'bot.list', () => ({ bots: host.store.listBots() })))
  router.register('bot.create', (params, _message, context) =>
    call(context, 'bot.create', () => ({
      bot: host.store.createBot({
        name: params.name,
        configPath: params.configPath,
        ...(params.mode === undefined ? {} : { mode: params.mode }),
      }),
    })))
  router.register('bot.update', (params, _message, context) =>
    call(context, 'bot.update', () => ({
      bot: host.store.updateBot(params.botId, {
        ...(params.name === undefined ? {} : { name: params.name }),
        ...(params.configPath === undefined ? {} : { configPath: params.configPath }),
        ...(params.mode === undefined ? {} : { mode: params.mode }),
      }),
    })))
  router.register('bot.control', (params, _message, context) =>
    call(context, 'bot.control', () => ({ bot: host.control(params.botId, params.action) })))
  router.register('bot.delete', (params, _message, context) =>
    call(context, 'bot.delete', () => {
      // Bot rows only: worktrees, sessions and branches are never removed.
      host.store.deleteBot(params.botId)
      return { deleted: true as const }
    }))
  router.register('bot.tick', (params, _message, context) =>
    call(context, 'bot.tick', async () => {
      await host.tick(params.botId)
      return { ticked: true as const }
    }))
  router.register('bot.config.validate', (params, _message, context) =>
    call(context, 'bot.config.validate', () => host.validateConfig(params.configPath)))
  router.register('bot.items', (params, _message, context) =>
    call(context, 'bot.items', () => ({ items: host.store.listItems(params.botId, params.state) })))
  router.register('bot.item.get', (params, _message, context) =>
    call(context, 'bot.item.get', () => ({ item: host.store.getItem(params.botId, params.itemId) })))
  router.register('bot.item.action', (params, _message, context) =>
    call(context, 'bot.item.action', async () => ({
      item: await host.itemAction(params.botId, params.itemId, params.action, params.answer),
    })))
  router.register('bot.log', (params, _message, context) =>
    call(context, 'bot.log', () => ({ entries: host.store.listLog(params.botId, params.afterSeq, params.limit) })))
  router.register('bot.health', (params, _message, context) =>
    call(context, 'bot.health', () => host.health(params.botId)))
}
