import type { RpcMethod } from '../common/methods.ts'
import type {
  BotConfigValidateParams,
  BotConfigValidateResult,
  BotControlParams,
  BotControlResult,
  BotCreateParams,
  BotCreateResult,
  BotDeleteParams,
  BotDeleteResult,
  BotHealthParams,
  BotHealthResult,
  BotItemActionParams,
  BotItemActionResult,
  BotItemGetParams,
  BotItemGetResult,
  BotItemsParams,
  BotItemsResult,
  BotListParams,
  BotListResult,
  BotLogParams,
  BotLogResult,
  BotTickParams,
  BotTickResult,
  BotUpdateParams,
  BotUpdateResult,
} from './types.ts'

export interface BotMethods {
  'bot.list': RpcMethod<BotListParams, BotListResult>
  'bot.create': RpcMethod<BotCreateParams, BotCreateResult>
  'bot.update': RpcMethod<BotUpdateParams, BotUpdateResult>
  'bot.control': RpcMethod<BotControlParams, BotControlResult>
  'bot.delete': RpcMethod<BotDeleteParams, BotDeleteResult>
  'bot.tick': RpcMethod<BotTickParams, BotTickResult>
  'bot.config.validate': RpcMethod<BotConfigValidateParams, BotConfigValidateResult>
  'bot.items': RpcMethod<BotItemsParams, BotItemsResult>
  'bot.item.get': RpcMethod<BotItemGetParams, BotItemGetResult>
  'bot.item.action': RpcMethod<BotItemActionParams, BotItemActionResult>
  'bot.log': RpcMethod<BotLogParams, BotLogResult>
  'bot.health': RpcMethod<BotHealthParams, BotHealthResult>
}
