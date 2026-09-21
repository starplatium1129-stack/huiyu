import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';

/** Cache the derived legacy projection without returning the whole library to browsers. */
export function createCharacterReferenceReader(rootDir: string) {
  const file = path.join(rootDir, 'data/character-reference-view.json');
  let signature = '';
  let profiles: Record<string, unknown> = {};
  return function readProfile(characterId: string, published?: Buffer): unknown {
    let bytes = published;
    if (!bytes) {
      const stat = fs.statSync(file);
      const next = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      if (signature !== next) {
        bytes = fs.readFileSync(file);
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid reference projection');
        profiles = parsed;
        signature = next;
      }
      return Object.hasOwn(profiles, characterId) ? profiles[characterId] : undefined;
    }
    const parsed = JSON.parse(bytes.toString('utf8'));
    return Object.hasOwn(parsed, characterId) ? parsed[characterId] : undefined;
  };
}

export function sendCharacterReferenceProfile(res: Response, id: string, read: (id: string, bytes?: Buffer) => unknown, bytes?: Buffer) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return res.status(400).json({ error: '角色 ID 无效' });
  const profile = read(id, bytes);
  if (!profile) return res.status(404).json({ error: '角色参考档案尚未登记' });
  return res.json(profile);
}
