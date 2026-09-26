import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import security = require('../security');

/** Health accepts a 64-hex challenge only. This non-hex domain prevents its public
 * proof endpoint from becoming a signing oracle for privileged host operations. */
export function desktopHostMessage(payload: string): string { return `aics-desktop-host:v1\n${payload}`; }
export function createDesktopHostVerifier(secret: string) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid desktop host secret');
  const seen = new Map<string, number>();
  return (req: Request, payload: string, timestamp: number, nonce: string): boolean => {
    if (!security.isDirectLocalRequest(req) || !security.hostAllowed(req.headers.host)
      || req.headers.origin || req.headers['sec-fetch-site'] || !Number.isSafeInteger(timestamp)
      || Math.abs(Date.now() - timestamp) > 30_000 || !/^[a-f0-9]{64}$/.test(nonce)) return false;
    for (const [key, expires] of seen) if (expires < Date.now()) seen.delete(key);
    if (seen.has(nonce)) return false;
    const proof = req.headers['x-aics-host-proof'];
    if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) return false;
    const expected = createHmac('sha256', secret).update(desktopHostMessage(payload)).digest();
    if (!timingSafeEqual(expected, Buffer.from(proof, 'hex'))) return false;
    seen.set(nonce, timestamp + 30_000);
    return true;
  };
}
