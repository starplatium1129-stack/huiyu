import type { RepairTags } from './scene-repair-tags';
import type { Diagnosis } from './scene-repair-model';
import { hash, type Data, type Kind } from './scene-repair-content';
import { tagKey } from '../../src/utils/animaPromptOrder.ts';
import { tokenize } from '../../src/utils/promptPrimitives.ts';

/** Deterministic edits use explicit authored intent, never a guessed pose or character trait. */
export function repairLocally(kind: Kind, source: Data, tags: RepairTags, controls: string[]): Diagnosis {
  const normalized = tags.normalize(kind, source, controls);
  const candidate = { ...source, ...normalized.patch }, issues = [...normalized.issues];
  const action = String(source.action || '');
  const feeding = (!source.compositionIntent || source.compositionIntent === 'single')
    && /喂食|喂饭|喂汤|\bfeeding\b/i.test(action)
    && /向前|递向|递送|喂你|喂给你|给前辈|towards? (?:the )?viewer|feeding (?:the )?viewer/i.test(action);
  if (feeding && /spoon|木勺|汤勺|勺子/i.test(`${source.action || ''} ${source.promptProse || ''}`)) {
    for (const field of kind === 'blueprint' ? ['promptTokens'] : ['prompt']) {
      const original = Array.isArray(candidate[field]) ? candidate[field] as string[] : tokenize(String(candidate[field] || ''));
      const next = original.flatMap(token => {
        if (tagKey(token) === 'tasting food') return [];
        if (tagKey(token) === 'offering food' && tags.has('feeding')) return ['feeding'];
        return [token];
      });
      if (hash(next) !== hash(original)) {
        candidate[field] = Array.isArray(candidate[field]) ? next : next.join(', ');
        issues.push({ field, evidence: String(source.action), reason: '当前动作明确为喂食，去掉自己尝味的同时动作，使用已有来源的喂食词' });
      }
    }
    const caption = String(candidate.animaCaption || '');
    const updated = caption.replace(/^\s*tasting soup from a wooden spoon\b/i, 'Offering a wooden spoon of soup toward the viewer');
    if (updated !== caption) {
      candidate.animaCaption = updated;
      issues.push({ field: 'animaCaption', evidence: caption, reason: '尾句与作者指定的递勺喂食动作对齐，保留其余光影和表情' });
    }
  }
  const patch = Object.fromEntries(Object.entries(candidate).filter(([field, value]) => hash(value) !== hash(source[field])));
  return { verdict: Object.keys(patch).length ? 'repair' : 'keep', patch, issues };
}

export function protectControls(kind: Kind, source: Data, candidate: Data, controls: string[]) {
  const fields = kind === 'blueprint' ? ['promptTokens', 'nsfwTokens'] : ['prompt'];
  const all = (data: Data) => new Set(fields.flatMap(field => Array.isArray(data[field]) ? data[field] as string[] : tokenize(String(data[field] || ''))).map(tagKey));
  const before = all(source), after = all(candidate);
  for (const control of controls.map(tagKey)) if (before.has(control) && !after.has(control))
    throw new Error(`候选丢失原有的精确控制词 ${control}`);
  for (const count of [...before].filter(token => /^(?:\d+\+?(?:girls?|boys?|others?|people)|solo|no humans|break)$/.test(token)))
    if (!after.has(count)) throw new Error(`候选改变了原有的人数或分区 ${count}`);
}
