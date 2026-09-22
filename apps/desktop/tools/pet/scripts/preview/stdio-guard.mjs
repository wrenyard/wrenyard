export function isBrokenPipe(error) {
  return error?.code === 'EPIPE';
}

export function rethrowUnlessBrokenPipe(error) {
  if (!isBrokenPipe(error)) {
    throw error;
  }
}

export function installBrokenPipeGuard(stream) {
  stream.on('error', (error) => {
    if (!isBrokenPipe(error)) {
      throw error;
    }
  });
}
