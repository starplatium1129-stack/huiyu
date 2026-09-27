import fs from 'node:fs';
import { assertSafePath } from './paths';
import { digest, mediaPath } from './media';
import { taskInputStagingKey, taskOutputStagingKey } from './task-media-keys';
import { thumbnailPath } from './thumbnails';
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
    // BEGIN IMMEDIATE keeps references and leases fixed for this collection pass.
    // Read them once instead of scanning the reference table for every object.
    const protectedHashes = new Set(context.db.prepare('SELECT hash FROM media_refs UNION SELECT hash FROM leases WHERE hash IS NOT NULL')
      .all().map(row => String(row.hash)));
    const deleteAliases = context.db.prepare('DELETE FROM media_aliases WHERE hash=?');
    const deleteObject = context.db.prepare('DELETE FROM media_objects WHERE hash=?');
    if (fs.existsSync(directory)) for (const prefix of fs.readdirSync(directory)) {
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
      const folder = assertSafePath(context.root, `media/objects/${prefix}`);
      if (!fs.statSync(folder).isDirectory()) continue;
      for (const hash of fs.readdirSync(folder)) {
        checkCancelled();
        if (!/^[a-f0-9]{64}$/.test(hash) || hash.slice(0, 2) !== prefix || protectedHashes.has(hash)) continue;
        const file = mediaPath(context.root, hash);
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.mtimeMs > Date.now() - TRASH_RETENTION_MS) continue;
        fs.unlinkSync(file);
        const thumbnail = thumbnailPath(context.root, hash);
        if (fs.existsSync(thumbnail)) fs.unlinkSync(thumbnail);
        deleteAliases.run(hash);
        deleteObject.run(hash);
        removed += 1;
      }
    }
    // A prior interrupted GC may have removed an unreferenced object before SQL
    // committed. Reconcile only missing, unprotected metadata; live refs never qualify.
    for (const row of context.db.prepare('SELECT hash FROM media_objects').all()) {
      const hash = String(row.hash);
      if (protectedHashes.has(hash) || fs.existsSync(mediaPath(context.root, hash))) continue;
      const thumbnail = thumbnailPath(context.root, hash);
      if (fs.existsSync(thumbnail)) fs.unlinkSync(thumbnail);
      deleteAliases.run(hash);
      deleteObject.run(hash);
      removed += 1;
    }
    const staging = assertSafePath(context.root, 'media/staging');
    if (fs.existsSync(staging)) {
      const completed = new Map<string, string | null>();
      for (const row of context.db.prepare("SELECT op_key FROM operations WHERE state IN ('committed','aborted')").iterate()) {
        completed.set(String(row.op_key), null);
      }
      // Task commits have their own durable records. A crash or busy file can leave
      // their staging link behind even though the original was committed safely.
      for (const row of context.db.prepare(`SELECT task_id,output_index AS identity,json_extract(media_json,'$.alias') AS alias,'output' AS kind
        FROM task_outputs WHERE committed=1 UNION ALL
        SELECT task_id,name AS identity,json_extract(media_json,'$.alias') AS alias,'input' AS kind
        FROM task_inputs WHERE committed=1`).iterate()) {
        const key = row.kind === 'output' ? taskOutputStagingKey(String(row.task_id), Number(row.identity))
          : taskInputStagingKey(String(row.task_id), String(row.identity));
        completed.set(key, digest(String(row.alias)));
      }
      const leased = new Set<string>();
      for (const row of context.db.prepare('SELECT id,operation_key FROM leases').iterate()) {
        leased.add(String(row.id));
        if (row.operation_key !== null) leased.add(String(row.operation_key));
      }
      for (const key of fs.readdirSync(staging)) {
        checkCancelled();
        if (!/^[a-f0-9]{64}$/.test(key) || !completed.has(key) || leased.has(key)) continue;
        const folder = assertSafePath(context.root, `media/staging/${key}`);
        const aliasHash = completed.get(key);
        for (const name of fs.readdirSync(folder)) {
          if (!/^[a-f0-9]{64}$/.test(name) || (aliasHash && name !== aliasHash)) continue;
          const file = assertSafePath(context.root, `media/staging/${key}/${name}`);
          const stat = fs.statSync(file);
          if (stat.isFile() && stat.mtimeMs <= Date.now() - TRASH_RETENTION_MS) fs.unlinkSync(file);
        }
        if (!fs.readdirSync(folder).length) fs.rmdirSync(folder);
      }
    }
    const receipt = { operationId: command.operationId, kind: command.kind, revision: nextRevision(context), removed };
    commitOperation(context, operation.op_key, receipt);
    return receipt;
  });
}
