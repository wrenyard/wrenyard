import type { RoleReasoningRequirement } from '@wrenyard/auto-routing';

export const BOT_ROUTING_REQUIREMENT: RoleReasoningRequirement = {
  intelligenceMin: 'mid',
  intelligenceExpected: 'premium',
  expectedTps: 200,
  minimumContextWindow: 131072,
  requiredCapabilities: ['text'],
  scoreWeights: { I: 0.4, P: 0.2, S: 0.2, Q: 0.2 },
  minimumReasoningEffort: 'high',
  ladder: [
    { intelligence: ['premium'], quotaState: 'abundant' },
    { intelligence: ['high'], quotaState: 'abundant' },
    { intelligence: ['premium'], quotaState: 'sufficient' },
    { intelligence: ['high'], quotaState: 'sufficient' },
    { intelligence: ['low', 'mid', 'high', 'premium'] },
  ],
};
