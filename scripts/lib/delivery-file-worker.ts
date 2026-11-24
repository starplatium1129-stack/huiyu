import { parentPort, workerData } from 'node:worker_threads';
import safe = require('./delivery-paths');

const { root, names } = workerData as { root: string; names: string[] };
safe.withLocalFileHashes(() => {
  const scan = safe.pathScan(root);
  parentPort!.postMessage(names.map(name => safe.fileEntry(root, name, scan)));
});
