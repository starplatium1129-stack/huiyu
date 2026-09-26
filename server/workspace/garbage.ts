import fs from 'node:fs';
import { assertSafePath } from './paths';
import { mediaPath } from './media';
import { checkOperation, commitOperation, findOperation, insertOperation, TRASH_RETENTION_MS } from './records';
import { nextRevision, type WorkspaceStorageContext } from './schema';
import type { MutationReceipt, WorkspaceCommand } from './types';

export function collectGarbage(context: WorkspaceStorageContext, principal: string,
  command: Extract<WorkspaceCommand, { kind: 'collectGarbage' }>, checkCancelled: () => void): MutationReceipt {
  const operation = context.transaction(() => {
    const previous = findOperation(context, principal, command.operationId);
    if (previous) {
      checkOperation(previous, command.kind, command);
      return previous;
    }
    insertOperation(context, principal, command.operationId, command.kind, command);
    return findOperation(context, principal, command.operationId)!;
  });
  if (operation.receipt_json) return JSON.parse(operation.receipt_json) as MutationReceipt;
  return context.transaction(() => {
    const directory = assertSafePath(context.root, 'media/objects');
    let removed = 0;
    const protectedHash = context.db.prepare('SELECT hash FROM media_refs WHERE hash=? UNION SELECT hash FROM leases WHERE hash=? LIMIT 1');
    if (fs.existsSync(directory)) for (const prefix of fs.readdirSync(directory)) {
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
      const folder = assertSafePath(context.root, `media/objects/${prefix}`);
      if (!fs.statSync(folder).isDirectory()) continue;
      for (const hash of fs.readdirSync(folder)) {
        checkCancelled();
        if (!/^[a-f0-9]{64}$/.test(hash) || hash.slice(0, 2) !== prefix || protectedHash.get(hash, hash)) continue;
        const file = mediaPath(context.root, hash);
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.mtimeMs > Date.now() - TRASH_RETENTION_MS) continue;
        fs.unlinkSync(file);
        context.db.prepare('DELETE FROM media_aliases WHERE hash=?').run(hash);
        context.db.prepare('DELETE FROM media_objects WHERE hash=?').run(hash);
        removed += 1;
      }
    }
    // A prior interrupted GC may have removed an unreferenced object before SQL
    // committed. Reconcile only missing, unprotected metadata; live refs never qualify.
    for (const row of context.db.prepare('SELECT hash FROM media_objects').all()) {
      const hash = String(row.hash);
      if (protectedHash.get(hash, hash) || fs.existsSync(mediaPath(context.root, hash))) continue;
      context.db.prepare('DELETE FROM media_aliases WHERE hash=?').run(hash);
      context.db.prepare('DELETE FROM media_objects WHERE hash=?').run(hash);
      removed += 1;
    }
    const staging = assertSafePath(context.root, 'media/staging');
    if (fs.existsSync(staging)) for (const key of fs.readdirSync(staging)) {
      checkCancelled();
      if (!/^[a-f0-9]{64}$/.test(key)) continue;
      const operationState = context.db.prepare('SELECT state FROM operations WHERE op_key=?').get(key)?.state;
      if (operationState !== 'committed' && operationState !== 'aborted') continue;
      if (context.db.prepare('SELECT id FROM leases WHERE operation_key=? LIMIT 1').get(key)) continue;
      const folder = assertSafePath(context.root, `media/staging/${key}`);
      for (const name of fs.readdirSync(folder)) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue;
        const file = assertSafePath(context.root, `media/staging/${key}/${name}`);
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.mtimeMs <= Date.now() - TRASH_RETENTION_MS) fs.unlinkSync(file);
      }
      if (!fs.readdirSync(folder).length) fs.rmdirSync(folder);
    }
    const receipt = { operationId: command.operationId, kind: command.kind, revision: nextRevision(context), removed };
    commitOperation(context, operation.op_key, receipt);
    return receipt;
  });
}
