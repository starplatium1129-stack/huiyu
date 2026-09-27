import { parentPort } from 'node:worker_threads';
import engine = require('./interrogate-engine');
import type { InterrogateOptions } from './interrogate-types';

if (!parentPort) throw new Error('WD14 worker requires a parent port');
parentPort.on('message', async (message: { image: Uint8Array; options: InterrogateOptions }) => {
  try {
    const result = await engine.interrogateTag(Buffer.from(message.image), message.options);
    parentPort!.postMessage({ result });
  } catch (error) {
    const failure = error as Error & { code?: string; status?: number };
    parentPort!.postMessage({ error: { message: failure.message, code: failure.code, status: failure.status } });
  }
});
