export function isBrokenPipe(error: unknown): boolean;
export function rethrowUnlessBrokenPipe(error: unknown): void;
export function installBrokenPipeGuard(stream: {
  on(event: string, listener: (error: unknown) => void): unknown;
}): void;
