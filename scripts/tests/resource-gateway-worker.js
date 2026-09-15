'use strict';

const fs = require('node:fs');
const { createResourceManager } = require('../lib/resource-install-gateway');
if (require.main === module && process.argv[2]) {
  try {
    const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const manager = createResourceManager(config);
    manager.start('download', 'network', true);
    let notified = false;
    setInterval(() => {
      const status = manager.status();
      if (!notified && status.task?.bytes > 0) { notified = true; process.send({ ready: true }); }
      if (status.task?.state === 'failed') { process.send({ error: status.task.error }); process.exit(1); }
    }, 5);
  } catch (error) { process.send({ error: { code: error.code, message: error.message } }); process.exit(1); }
}
