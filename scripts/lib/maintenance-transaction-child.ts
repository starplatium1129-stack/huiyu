'use strict';

// The parent must durably register our PID before sending start. If it disappears,
// recovery still waits for this process to exit before touching any target files.
if (require.main === module) {
  const script = process.argv[2];
  const args = process.argv.slice(3);
  const disconnected = () => process.exit(70);
  process.once('disconnect', disconnected);
  process.once('message', (message: any) => {
    if (!message || message.type !== 'start') return process.exit(71);
    process.argv = [process.execPath, script, ...args];
    if (process.channel) process.channel.unref();
    (require('node:module') as typeof import('node:module')).runMain(script);
  });
  if (!process.send) process.exit(72);
  process.send({ type: 'ready' });
}
