import { describe, expect, it } from 'vitest';
import type { GatewayModel } from '@wrenyard/protocol/gateway';

import { resolveModelMetadata } from '../src/metadata.ts';

const PUBLIC_ID = 'example-provider/example-model';

function endpointModel(overrides: Partial<GatewayModel> = {}): GatewayModel {
  return {
    id: 'example-model',
    publicId: PUBLIC_ID,
    provider: 'example-provider',
    protocols: ['openai_chat'],
    displayName: 'Example Model',
    ...overrides,
  };
}

// Source: endpoint model metadata decision, R3 approved cases.
describe('endpoint model metadata', () => {
  it('takes the model list and context window from the endpoint', () => {
    const models = [
      endpointModel({ publicId: 'other-provider/other-model' }),
      endpointModel({ contextWindow: 200_000, maxOutputTokens: 32_000 }),
    ];
    expect(resolveModelMetadata(PUBLIC_ID, models)).toMatchObject({
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
    });
  });

  it('reads reasoning levels and image capability from the endpoint', () => {
    const metadata = resolveModelMetadata(PUBLIC_ID, [
      endpointModel({ reasoningEfforts: ['low', 'high'], capabilities: ['text', 'image'] }),
    ]);
    expect(metadata.reasoningEfforts).toEqual(['low', 'high']);
    expect(metadata.imageInput).toBe(true);
  });
});
