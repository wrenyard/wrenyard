declare const __WRENYARD_DESKTOP_BUILD_TIME__: string | undefined;

function injectedBuildTime(): unknown {
  return typeof __WRENYARD_DESKTOP_BUILD_TIME__ === 'string'
    ? __WRENYARD_DESKTOP_BUILD_TIME__
    : undefined;
}

export function resolveDesktopBuildTime(value: unknown = injectedBuildTime()): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}
