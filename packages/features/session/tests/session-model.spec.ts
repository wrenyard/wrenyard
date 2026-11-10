import { describe, expect, it } from 'vitest';
import type { GatewayModel } from '@wrenyard/ai-protocol';

import { admitSessionModel } from '../src/model/admission.ts';

// Source: endpoint model metadata decision, R3 approved case.
describe('session model admission', () => {
  it('admits a model the endpoint lists', () => {
    const models: GatewayModel[] = [{
      id: 'endpoint-only-model',
      publicId: 'endpoint-provider/endpoint-only-model',
      provider: 'endpoint-provider',
      protocols: ['openai_chat'],
      displayName: 'Endpoint Only Model',
    }];
    expect(admitSessionModel(models, 'endpoint-provider', 'endpoint-only-model').publicId)
      .toBe('endpoint-provider/endpoint-only-model');
  });
});
