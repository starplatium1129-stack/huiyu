'use strict';

// Internal staging step, not an install/download or user-selected filesystem API.
const { applyResourceProfile } = require('../lib/resource-install-packaging');
async function main(args) {
  if (args.includes('--help') || args.includes('--plan')) {
    console.log('Internal desktop staging helper: <source root> <fresh gateway staging root> <full|base>. Called by desktop-stage-resources; does not install or download. Help/plan read no target files.');
    return;
  }
  if (args.length !== 3) throw new Error('Expected source root, fresh gateway staging root, and profile');
  await applyResourceProfile({ root: args[0], gatewayRoot: args[1], profile: args[2] });
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
module.exports = { main };
