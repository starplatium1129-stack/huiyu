'use strict';
const fs = require('node:fs');
const { publishReferenceCandidates } = require('../lib/reference-candidate-publish');
if (require.main === module) {
  const options = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  publishReferenceCandidates(options, { onPhase: async phase => {
    if (phase === process.argv[3]) {
      process.send?.({ phase });
      await new Promise(() => {});
    }
  } }).then(result => { process.send?.({ result }); process.disconnect?.(); })
    .catch(error => { process.send?.({ error: error.message, code: error.code }); process.exitCode = 1; process.disconnect?.(); });
}
