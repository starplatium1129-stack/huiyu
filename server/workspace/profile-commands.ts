import { nextRevision, type WorkspaceStorageContext } from './schema';
import { checkOperation, commitOperation, findOperation, insertOperation } from './records';
import { WorkspaceError, type ExecuteOptions, type WorkspaceContext } from './types';
import type { ProfileDomain, ProfileRecord, ProfileSnapshot } from '../../types/profile';
import { profileDomainForKey } from './profile-fields';
import type { ProfileCommand, ProfileResult } from './profile-types';

function readReset(storage: WorkspaceStorageContext): string {
  const row = storage.db.prepare("SELECT body FROM profile_records WHERE domain='chat' AND record_key='aics_chat_reset_v1'").get();
  return row ? String(JSON.parse(String(row.body))) : '';
}
function snapshot(storage: WorkspaceStorageContext, domain: ProfileDomain, windowId?: string): ProfileSnapshot {
  const records = storage.db.prepare('SELECT record_key,body,revision FROM profile_records WHERE domain=? ORDER BY record_key').all(domain)
    .filter(row => domain !== 'draft' || !String(row.record_key).includes(':aics_') || String(row.record_key).startsWith(`${windowId}:`))
    .map(row => ({ key: String(row.record_key).startsWith(`${windowId}:`) ? String(row.record_key).slice(windowId!.length + 1) : String(row.record_key), value: JSON.parse(String(row.body)) as unknown, revision: Number(row.revision) }));
  return { records, revision: Number(storage.db.prepare("SELECT value FROM meta WHERE key='revision'").get()!.value), resetRevision: readReset(storage) };
}
function containsCredential(value: unknown): boolean {
  if (typeof value === 'string') { try { return containsCredential(JSON.parse(value)); } catch { return false; } }
  return Boolean(value && typeof value === 'object' && Object.entries(value).some(([key, item]) =>
    (/^(api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token|token)$/i.test(key) && item !== '' && item !== null && item !== undefined)
    || (item && typeof item === 'object' && containsCredential(item))));
}
export async function executeProfile(storage: WorkspaceStorageContext, command: ProfileCommand, context: WorkspaceContext,
  _options: ExecuteOptions = {}): Promise<ProfileResult> {
  if (command.kind === 'profile.readSettings') return snapshot(storage, 'settings');
  if (command.kind === 'profile.readChat') return snapshot(storage, 'chat');
  if (command.kind === 'profile.readDrafts') return snapshot(storage, 'draft', command.windowId);
  return storage.transaction(() => {
    const previous = findOperation(storage, context.principalId, command.operationId);
    if (previous) {
      checkOperation(previous, command.kind, command);
      if (previous.receipt_json) return (JSON.parse(previous.receipt_json) as { profile: ProfileResult }).profile;
    }
    if ('expectedReset' in command && command.expectedReset !== readReset(storage)) throw new WorkspaceError('PROFILE_RESET_CONFLICT', 'Chat was reset in another window; reload before writing');
    const operation = insertOperation(storage, context.principalId, command.operationId, command.kind, command);
    const revision = nextRevision(storage);
    let result: ProfileResult;
    if (command.kind === 'profile.resetChat') {
      const current = storage.db.prepare("SELECT body FROM profile_records WHERE domain='chat' AND record_key='aics_chat_v1'").get();
      let retained: unknown = null;
      if (current) {
        const decoded: unknown = JSON.parse(String(current.body));
        const record = (typeof decoded === 'string' ? JSON.parse(decoded) : decoded) as Record<string, unknown>;
        const settings = record.settings as Record<string, unknown> | undefined;
        retained = JSON.stringify({ ...record, histories: {}, historiesRevision: revision, historiesRevisions: {}, settings: { ...settings, drafts: {} } });
      }
      storage.db.exec("DELETE FROM profile_records WHERE domain='chat' OR (domain='draft' AND record_key LIKE 'aics_chat_draft_v1:%')");
      if (retained) storage.db.prepare('INSERT INTO profile_records VALUES(?,?,?,?)').run('chat', 'aics_chat_v1', JSON.stringify(retained), revision);
      storage.db.prepare('INSERT INTO profile_records VALUES(?,?,?,?)').run('chat', 'aics_chat_reset_v1', JSON.stringify(command.operationId), revision);
      result = snapshot(storage, 'chat');
    } else {
      const domain = command.kind === 'profile.saveSetting' ? 'settings' : command.kind === 'profile.saveChatRecord' ? 'chat' : 'draft';
      if (profileDomainForKey(command.key) !== domain || command.key === 'aics_chat_reset_v1' || containsCredential(command.value)) {
        throw new WorkspaceError('INVALID_COMMAND', 'Profile field is outside the domain contract or contains a credential', 400);
      }
      const key = command.kind === 'profile.saveDraft' && command.windowId ? `${command.windowId}:${command.key}` : command.key;
      const row = storage.db.prepare('SELECT revision FROM profile_records WHERE domain=? AND record_key=?').get(domain, key);
      if ((row ? Number(row.revision) : null) !== command.expectedRevision) throw new WorkspaceError('REVISION_CONFLICT', 'Profile record has a newer revision');
      storage.db.prepare('INSERT INTO profile_records VALUES(?,?,?,?) ON CONFLICT(domain,record_key) DO UPDATE SET body=excluded.body,revision=excluded.revision')
        .run(domain, key, JSON.stringify(command.value), revision);
      result = { key: command.key, value: command.value, revision } satisfies ProfileRecord;
    }
    commitOperation(storage, operation, { operationId: command.operationId, kind: command.kind, revision, ...{ profile: result } });
    return result;
  });
}
