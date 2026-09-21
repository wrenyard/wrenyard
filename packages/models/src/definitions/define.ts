import type { ModelDefaults, ModelNativeAttributes, RegisteredModel } from '../types.ts';

export function defineModel(
  id: string,
  displayName: string,
  defaults: ModelDefaults,
  extra: { lab: string; family?: string; version?: string; native?: ModelNativeAttributes },
): RegisteredModel {
  return {
    id,
    displayName,
    lab: extra.lab,
    defaults,
    ...(extra.family ? { family: extra.family } : {}),
    ...(extra.version ? { version: extra.version } : {}),
    ...(extra.native ? { native: extra.native } : {}),
  };
}
