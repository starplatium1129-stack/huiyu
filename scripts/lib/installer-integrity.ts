import fs = require('node:fs');
import crypto = require('node:crypto');
import type { WithImplicitCoercion } from 'node:buffer';
import type { PathOrFileDescriptor } from 'node:fs';

// Installer payloads are hundreds of MiB. Keep hash buffers bounded while still
// reading every byte; retain caller ownership when passed an open descriptor.
export function hashInstallerFile(file: PathOrFileDescriptor, algorithm: 'sha256' | 'blake2b512'): Buffer {
  const descriptor = typeof file === 'number' ? file : fs.openSync(file, 'r');
  try {
    const hash = crypto.createHash(algorithm), buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest();
  } finally { if (typeof file !== 'number') fs.closeSync(descriptor); }
}

export function verifyUpdaterSignature(executable: PathOrFileDescriptor, signature: WithImplicitCoercion<string>, publicKey: WithImplicitCoercion<string>) {
  const key = Buffer.from(Buffer.from(publicKey, 'base64').toString('utf8').trim().split(/\r?\n/)[1] || '', 'base64');
  const lines = Buffer.from(signature, 'base64').toString('utf8').trim().split(/\r?\n/);
  const packet = Buffer.from(lines[1] || '', 'base64');
  if (key.length !== 42 || packet.length !== 74 || !key.subarray(2, 10).equals(packet.subarray(2, 10))) throw new Error('Updater signing key mismatch');
  const algorithm = packet.subarray(0, 2).toString();
  if (!['ED', 'Ed'].includes(algorithm)) throw new Error('Unsupported updater signature algorithm');
  const verifier = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  const message = algorithm === 'ED' ? hashInstallerFile(executable, 'blake2b512') : fs.readFileSync(executable);
  if (!crypto.verify(null, message, verifier, packet.subarray(10))) throw new Error('Distributed installer signature verification failed');
  if (!lines[2]?.startsWith('trusted comment: ') || !crypto.verify(null, Buffer.concat([packet.subarray(10), Buffer.from(lines[2].slice(17))]), verifier, Buffer.from(lines[3] || '', 'base64'))) throw new Error('Updater trusted comment verification failed');
  return true;
}
