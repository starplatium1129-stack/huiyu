import { createPromptTagDictionary, type PromptTagSource } from '../../src/utils/promptTagDictionary.ts';
import { tokenize } from '../../src/utils/promptPrimitives.ts';
import { tagKey } from '../../src/utils/animaPromptOrder.ts';
import { object, hash, type Data, type Kind } from './scene-repair-content';
import type { Issue } from './scene-repair-model';

interface Proof { canonicalTag: string; url: string; checkedAt: string; postCount: number; category: string }
export interface TagFinding { token: string; status: 'verified' | 'alias' | 'unverified' | 'control'; proof?: Proof }
const key = (value: string) => tagKey(value).replace(/ /g, '_');
function proof(value: unknown): value is Proof {
  if (!object(value) || typeof value.canonicalTag !== 'string' || !value.canonicalTag.trim()
    || typeof value.url !== 'string' || typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))
    || typeof value.category !== 'string' || typeof value.postCount !== 'number' || value.postCount < 1) return false;
  try { const url = new URL(value.url); return url.protocol === 'https:' && ['gelbooru.com', 'danbooru.donmai.us'].includes(url.hostname); }
  catch { return false; }
}

const replacements: Record<string, { tags: string[]; retained?: RegExp }> = {
  blushing: { tags: ['blush'] },
  looking_at_the_viewer: { tags: ['looking at viewer'] },
  looking_towards_viewer: { tags: ['looking at viewer'] },
  sweet_smile: { tags: ['smile'], retained: /sweet|affection|loving|tender|cheerful/i },
  knit_sweater: { tags: ['sweater'] },
  wooden_spoon: { tags: ['spoon'], retained: /wooden/i },
  steaming_pot: { tags: ['cooking pot', 'steam'] },
  warm_indoor_lighting: { tags: ['warm lighting', 'indoors'] },
};

/** Local source evidence is the fast path. Network enrichment is optional and batched. */
export class RepairTags {
  private proofs = new Map<string, Proof>();
  private dictionary: ReturnType<typeof createPromptTagDictionary>;
  private offline = new Set<string>();
  private checked = new Set<string>();
  private pending = new Map<string, Promise<void>>();
  private enrichment = Promise.resolve();
  constructor(tags: unknown, readonly signal: AbortSignal, readonly saveRaw: (label: string, value: unknown) => void,
    readonly online = false, cache?: unknown) {
    if (!Array.isArray(tags) || !tags.every(object)) throw new Error('权威词条库无效');
    const verified: PromptTagSource[] = [];
    for (const tag of tags) {
      if (tag.status === 'retired' || typeof tag.en !== 'string' || !proof(tag.verification)
        || key(tag.en) !== key(tag.verification.canonicalTag)) continue;
      this.proofs.set(key(tag.en), tag.verification);
      verified.push(tag as unknown as PromptTagSource);
    }
    if (Array.isArray(cache)) for (const item of cache) if (proof(item)) this.proofs.set(key(item.canonicalTag), item);
    this.dictionary = createPromptTagDictionary(verified);
  }
  snapshot() { return [...this.proofs.values()]; }
  has(tag: string) { return this.proofs.has(key(tag)); }
  vocabulary(tokens: string[]) {
    const words = new Set(tokens.flatMap(token => key(token).split('_')));
    return [...this.proofs.values()].filter(item => key(item.canonicalTag).split('_').some(word => words.has(word)))
      .slice(0, 100).map(item => item.canonicalTag);
  }
  private finding(token: string, controls: ReadonlySet<string>): TagFinding {
    const name = key(token);
    if (controls.has(name) || /^(?:BREAK|<lora:[^>]+>|score_\d+)$/i.test(token.trim())) return { token, status: 'control' };
    const canonical = this.dictionary.lookup(name)?.canonicalTag || name;
    const found = this.proofs.get(key(canonical));
    return !found ? { token, status: 'unverified' }
      : { token, status: name === key(found.canonicalTag) ? 'verified' : 'alias', proof: found };
  }
  private async batch(names: string[], site: 'g' | 'd') {
    if (this.offline.has(site) || !names.length) return;
    const url = site === 'g' ? new URL('https://gelbooru.com/index.php') : new URL('https://danbooru.donmai.us/tags.json');
    if (site === 'g') {
      for (const [name, value] of Object.entries({ page: 'dapi', s: 'tag', q: 'index', json: '1', names: names.join(' '), limit: '100' }))
        url.searchParams.set(name, value);
      if (process.env.GELBOORU_API_KEY && process.env.GELBOORU_USER_ID) {
        url.searchParams.set('api_key', process.env.GELBOORU_API_KEY); url.searchParams.set('user_id', process.env.GELBOORU_USER_ID);
      }
    } else { url.searchParams.set('search[name]', names.join(',')); url.searchParams.set('limit', '100'); }
    try {
      const response = await fetch(url, { redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'Huiyu-Scene-Maintenance/2.0' },
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(2500)]) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const part of response.body || []) {
        size += part.length;
        if (size > 2 * 1024 * 1024) throw new Error('来源响应过大');
        chunks.push(part);
      }
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const items = site === 'g' && object(raw) ? raw.tag ?? [] : raw;
      if (!Array.isArray(items) || !items.every(object)) throw new Error('来源响应格式无效');
      this.saveRaw('tag-source', { site, result: raw });
      for (const item of items) {
        if (typeof item.name !== 'string' || !names.includes(item.name) || item.is_deprecated === true) continue;
        const count = Number(site === 'g' ? item.count : item.post_count);
        if (!Number.isSafeInteger(count) || count < 1) continue;
        this.proofs.set(item.name, { canonicalTag: item.name, postCount: count, checkedAt: new Date().toISOString(),
          category: String(site === 'g' ? item.type : item.category), url: site === 'g'
            ? `https://gelbooru.com/index.php?page=post&s=list&tags=${encodeURIComponent(item.name)}`
            : `https://danbooru.donmai.us/posts?tags=${encodeURIComponent(item.name)}` });
      }
    } catch (error) {
      this.signal.throwIfAborted(); this.offline.add(site);
      console.error(`[来源补充] ${site === 'g' ? 'G' : 'D'}站不可用，继续使用本地来源词库：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async scan(kind: Kind, data: Data, compiled: { tagText: string; negative: string; protectedTags: string[] }) {
    const controls = new Set(compiled.protectedTags.map(key));
    const fields = kind === 'blueprint' ? ['promptTokens', 'nsfwTokens', 'negativeTokens'] : ['prompt', 'negative'];
    const tokens = [...new Set([...fields.flatMap(field => Array.isArray(data[field]) ? data[field] as string[] : tokenize(String(data[field] || ''))),
      ...tokenize(compiled.tagText.replace(/\bBREAK\b/g, ',')), ...tokenize(compiled.negative)])];
    if (this.online) {
      const all = [...new Set(tokens.filter(token => this.finding(token, controls).status === 'unverified').map(key))];
      const names = all.filter(name => !this.checked.has(name));
      if (names.length) {
        names.forEach(name => this.checked.add(name));
        const request = this.enrichment.then(async () => {
          for (let offset = 0; offset < names.length; offset += 100) {
            const chunk = names.slice(offset, offset + 100);
            await this.batch(chunk, 'g');
            await this.batch(chunk.filter(name => !this.proofs.has(name)), 'd');
          }
        });
        this.enrichment = request;
        names.forEach(name => this.pending.set(name, request));
      }
      await Promise.all([...new Set(all.map(name => this.pending.get(name)).filter(item => item !== undefined))]);
    }
    const findings = tokens.map(token => this.finding(token, controls));
    const bad = findings.filter(item => item.status === 'unverified'), aliases = findings.filter(item => item.status === 'alias');
    return { findings, bad, aliases, ok: !bad.length && !aliases.length };
  }
  normalize(kind: Kind, source: Data, protectedTags: string[]) {
    const controls = new Set(protectedTags.map(key)), patch: Data = {}, issues: Issue[] = [];
    const fields = kind === 'blueprint' ? ['promptTokens', 'nsfwTokens', 'negativeTokens'] : ['prompt', 'negative'];
    const description = String(source.animaCaption || source.promptProse || '');
    for (const field of fields) {
      if (source[field] === undefined) continue;
      const original = Array.isArray(source[field]) ? source[field] as string[] : tokenize(String(source[field]));
      const next: string[] = [];
      for (const token of original) {
        const finding = this.finding(token, controls), rule = replacements[key(token)];
        let targets: string[] | undefined;
        if (finding.status === 'alias') targets = [finding.proof!.canonicalTag];
        else if (finding.status === 'unverified' && rule && rule.tags.every(tag => this.proofs.has(key(tag)))) {
          // Keep authored prose intact; only simplify when its nuance is already expressed there.
          if (rule.retained && !rule.retained.test(description)
            || (rule.retained || rule.tags.length > 1) && ['negativeTokens', 'negative'].includes(field)) { next.push(token); continue; }
          targets = rule.tags;
        }
        if (!targets) { next.push(token); continue; }
        const weight = /^\((.*):\s*([+-]?(?:\d*\.)?\d+)\)$/.exec(token.trim());
        const updated = targets.map(tag => {
          const canonical = tag.replace(/_/g, ' ');
          return weight ? `(${canonical}:${weight[2]})` : canonical;
        });
        next.push(...updated);
        issues.push({ field, evidence: token, reason: `按已有 D/G 来源词条改为 ${updated.join(', ')}` });
      }
      if (hash(original) !== hash(next)) patch[field] = Array.isArray(source[field]) ? next : next.join(', ');
    }
    return { patch, issues };
  }
}
