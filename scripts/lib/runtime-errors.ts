/** Read caught values without assuming that every library throws an Error instance. */
export function errorField(error: any, key: string): any {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? (error as Record<string, any>)[key] : undefined;
}

export function errorMessage(error: any): string {
  const message = errorField(error, 'message');
  return message === undefined || message === null ? String(error) : String(message);
}

export function errorCode(error: any): string | number | undefined {
  const code = errorField(error, 'code');
  return typeof code === 'string' || typeof code === 'number' ? code : undefined;
}

export function errorStatus(error: any, key: 'status' | 'statusCode' = 'status'): number | undefined {
  const status = errorField(error, key);
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

export function errorStack(error: any): string | undefined {
  const stack = errorField(error, 'stack');
  return typeof stack === 'string' ? stack : undefined;
}

export function errorOutput(error: any, key: 'stdout' | 'stderr'): string | Buffer | undefined {
  const output = errorField(error, key);
  return typeof output === 'string' || Buffer.isBuffer(output) ? output : undefined;
}
