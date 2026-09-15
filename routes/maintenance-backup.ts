'use strict';

// The first three arguments and all existing manifest fields remain compatible.
// Recovery additionally requires the fourth, trusted root/runtime configuration.
export = (require('../scripts/lib/maintenance-recovery-backup') as typeof import('../scripts/lib/maintenance-recovery-backup'));
