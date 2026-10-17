import { defineModel } from './define.ts';

export const reflectionModels = [
  // The intelligence tier is a product classification informed by the AA
  // Intelligence Index of 30 for this model, not a tier the source publishes.
  // Speed 227 floors the AA generation rate of 227.9 tokens/s measured after
  // the first streamed chunk (https://artificialanalysis.ai/models/reflection-beam).
  // Identity mapping: https://models.opencode.ai/providers/opencode/ and the
  // models.dev canonical page. Pricing and maxOutputTokens stay absent: neither
  // is established for this identity.
  defineModel('beam-1.0-501b-a23b', 'Beam 1.0 501B A23B', {
    intelligence: 'mid',
    capabilities: ['text'],
    contextWindow: 1_048_576,
    speed: 227,
  }, { lab: 'reflection', family: 'beam' }),
];
