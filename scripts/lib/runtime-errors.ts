/** Read caught values without assuming that every library throws an Error instance. */
function errorField(error: unknown, key: string): unknown {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? (error as Record<string, unknown>)[key] : undefined;
}

export function errorMessage(error: unknown): string {
  const message = errorField(error, 'message');
  return message === undefined || message === null ? String(error) : String(message);
}

export function errorStack(error: unknown): string {
  const stack = errorField(error, 'stack');
  return stack ? String(stack) : errorMessage(error);
}

export function errorCode(error: unknown): string | number | undefined {
  const code = errorField(error, 'code');
  return typeof code === 'string' || typeof code === 'number' ? code : undefined;
}

export function errorOutput(error: unknown, key: 'stdout' | 'stderr'): string | Buffer | undefined {
  const output = errorField(error, key);
  return typeof output === 'string' || Buffer.isBuffer(output) ? output : undefined;
}
