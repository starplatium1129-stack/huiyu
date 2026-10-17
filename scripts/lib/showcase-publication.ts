import fs = require('node:fs');
import path = require('node:path');
import { errorMessage } from './runtime-errors';

/** Publish a prepared showcase directory, retaining the previous version until replacement succeeds. */
function switchTarget(tempDir: string, targetDir: string, force: boolean): void {
  const backupDir = path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.backup-${process.pid}`);
  const targetExists = fs.existsSync(targetDir);
  if (targetExists) {
    if (!force) throw new Error(`target already exists: ${targetDir} (use --force to overwrite)`);
    if (!fs.existsSync(path.join(targetDir, 'manifest.json'))) throw new Error(`refusing to replace target without manifest.json: ${targetDir}`);
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.renameSync(targetDir, backupDir);
  }
  try {
    fs.renameSync(tempDir, targetDir);
  } catch (error) {
    if (targetExists) {
      try { fs.renameSync(backupDir, targetDir); } catch (restoreError) {
        (error as Error).message = `${errorMessage(error)}\n  additionally failed to restore backup ${backupDir}: ${errorMessage(restoreError)}`;
      }
    }
    throw error;
  }
  if (targetExists) fs.rmSync(backupDir, { recursive: true, force: true });
}

export = { switchTarget };
