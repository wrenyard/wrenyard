import { defineProvider, model, openAI, anthropic, REASONING_LOW_HIGH_MAX } from '../base/model-defaults.ts';
import { object, time } from '../base/quota-parsing.ts';

function upstreamErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.message === 'string') return record.message;
  const error = record.error;
  if (typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>).message === 'string') {
    return (error as Record<string, unknown>).message as string;
  }
  return undefined;
}

const MESSAGE_RESET_PATTERN = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*UTC([+-])(\d{1,2})(?::?(\d{2}))?[^\r\n]*?(?:重置|reset)/iu;

function messageReset(message: string | undefined): string | undefined {
  const reset = message === undefined ? null : MESSAGE_RESET_PATTERN.exec(message);
  if (reset === null) return undefined;
  const [, date, clock, sign, hourText, minuteText] = reset;
  const hour = Number(hourText);
  const minute = Number(minuteText ?? '0');
  if (hour > 23 || minute > 59) return undefined;
  const [year, month, day] = date!.split('-').map(Number);
  const [hours, minutes, seconds] = clock!.split(':').map(Number);
  const calendar = new Date(Date.UTC(year!, month! - 1, day!, hours!, minutes!, seconds!));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month! - 1 || calendar.getUTCDate() !== day) return undefined;
  const offset = `${sign}${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const normalized = time(`${date}T${clock}${offset}`);
  return normalized;
}

function upstreamReset(body: unknown, message: string | undefined): string | undefined {
  const root = object(body);
  const error = object(root.error);
  const explicit = error.resets_at ?? error.reset_at ?? root.resets_at ?? root.reset_at;
  return time(explicit) ?? messageReset(message);
}

export const definition = defineProvider({
  modelProtocols: ['openai_chat', 'anthropic_messages'],
  id: 'zhipu-coding', displayName: 'Zhipu Coding', credentialResolver: 'managed', defaultModel: 'glm-5.3', quotaProvider: 'zhipu-coding',
  models: [
    model('glm-5.3', 1_048_576, 32_768, undefined, REASONING_LOW_HIGH_MAX),
    model('glm-5.3-flash', 1_048_576, 32_768, undefined, REASONING_LOW_HIGH_MAX),
  ],
  protocols: [openAI('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'), anthropic('https://open.bigmodel.cn/api/anthropic/v1/messages')],
  classifyUpstreamError({ body }) {
    const message = upstreamErrorMessage(body);
    if (message?.includes('您的账户已达到速率限制')) {
      const until = upstreamReset(body, message);
      return { state: 'rate_limited', scope: 'provider', ...(until ? { until } : {}) };
    }
    return undefined;
  },
  // GLM often answers in plain text when a tool call is forced, so selection
  // must never route a forced tool choice here.
  supportsForcedToolChoice: false,
  convertReasoningEffort: (_modelId, effort, protocol) => {
    if (protocol === 'openai_responses') return { reasoning: { effort } };
    if (protocol === 'anthropic_messages') return { thinking: { type: 'enabled' }, output_config: { effort } };
    return { reasoning_effort: effort };
  },
  description: '智谱 GLM 5.3 系列编程模型与订阅额度。',
  setupHint: '输入 GLM Coding API Key；Key 仅写入本机 Wrenyard runtime。',
});
