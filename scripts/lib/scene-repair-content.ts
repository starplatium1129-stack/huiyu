import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { compilePromptRecipe } from '../../src/utils/promptRecipe.ts';
import { parsePopularCharacter, parseSceneBlueprint, defaultOutfit } from '../../src/utils/popularContent.ts';
import { parsePromptScenes, parsePromptLoras } from '../../src/utils/promptCatalog.ts';
import { parsePresetCatalog } from '../../src/utils/modelProfileDefaults.ts';
import { resolveModelProfile, parseScenePromptLoras } from '../../src/utils/promptPolicy.ts';
import models = require('./generation/anima-model-catalog');
const { endfieldAnimaBinding } = require('../../src/utils/loraCatalog.ts') as {
  endfieldAnimaBinding: (id: string, family: string, model: string) =>
    { character: string; loraId: string; loraStrength: number } | null;
};

export type Data = Record<string, unknown>;
export type Kind = 'blueprint' | 'scene';
export interface ContentRecord<T = Data> { kind: Kind | 'character' | 'outfit' | 'document'; id: string; revision: number; data: T }
export interface Context { record: ContentRecord; authoring: Data; dependencies: ContentRecord<Data | unknown[]>[] }
export const referenceId = 'hoolheyak_arknights_river_postcards';
export const object = (value: unknown): value is Data => !!value && typeof value === 'object' && !Array.isArray(value);
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) =>
  object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) ?? 'undefined').digest('hex');
const runFile = promisify(execFile);

export function record<T = Data>(value: unknown): ContentRecord<T> {
  if (!object(value) || !['blueprint', 'scene', 'character', 'outfit', 'document'].includes(String(value.kind))
    || typeof value.id !== 'string' || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || !(object(value.data) || value.kind === 'document' && Array.isArray(value.data)))
    throw new Error('内容记录缺少有效身份、修订或数据');
  return value as unknown as ContentRecord<T>;
}

export class RepairCatalog {
  private initialized?: Promise<void>;
  private executable?: string;
  private authoringCache = new Map<string, Promise<Data>>();
  invalidate() { this.authoringCache.clear(); }
  constructor(readonly root: string, readonly runtime: string, readonly signal: AbortSignal) {
    if (!fs.existsSync(path.join(runtime, 'content/catalog.sqlite'))) throw new Error('权威内容库不存在，停止；不会从快照新建');
  }
  async call(action: string, args: string[] = []): Promise<Data> {
    this.signal.throwIfAborted();
    this.initialized ??= (async () => {
      await runFile(process.execPath, [path.join(this.root, 'scripts/maintenance/run-rust-runtime.js'),
        'catalog', 'stats', '--root', this.root, '--runtime-root', this.runtime],
      { cwd: this.root, windowsHide: true, encoding: 'utf8', signal: this.signal, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
      const binary = path.join(this.root, 'runtime-rs/target/debug', process.platform === 'win32' ? 'huiyu-runtime.exe' : 'huiyu-runtime');
      if (!fs.existsSync(binary)) throw new Error('原生内容工具构建后未找到可执行文件');
      this.executable = binary;
    })();
    await this.initialized;
    const { stdout } = await runFile(this.executable!, [
      'catalog', action, '--root', this.root, '--runtime-root', this.runtime, ...args],
    { cwd: this.root, windowsHide: true, encoding: 'utf8', signal: this.signal, timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
    const value: unknown = JSON.parse(stdout);
    if (!object(value) || value.ok !== true) throw new Error(`内容库 ${action} 失败`);
    return value;
  }
  async read<T = Data>(kind: string, id: string) { return record<T>((await this.call('record', ['--kind', kind, '--id', id])).record); }
  async context(kind: Kind, id: string, refresh = false): Promise<Context> {
    const item = await this.read(kind, id);
    if (kind === 'scene') {
      const authoring = await this.call('authoring', ['--kind', 'scene', '--id', id]);
      if (hash(record(authoring.record)) !== hash(item)) throw new Error('场景在读取上下文时发生变化');
      return { record: item, authoring, dependencies: [await this.read<unknown[]>('document', 'loras')] };
    }
    const character = item.data.characterId;
    if (typeof character !== 'string' || !character) throw new Error('蓝图缺少角色绑定');
    let request = !refresh ? this.authoringCache.get(character) : undefined;
    if (!request) {
      request = this.call('authoring', ['--character', character]);
      this.authoringCache.set(character, request);
    }
    const authoring = await request;
    if (!Array.isArray(authoring.outfits)) throw new Error('角色上下文缺少服装');
    return structuredClone({ record: item, authoring, dependencies: [record(authoring.referenceCharacter), ...authoring.outfits.map(record)] });
  }
  async select(kind: Kind, character?: string): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const result = await this.call('query', ['--kind', kind, '--page', String(page), '--page-size', '100',
        ...(character ? ['--character', character] : [])]);
      if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total)) throw new Error('内容查询结果无效');
      for (const item of result.items) {
        if (!object(item) || typeof item.id !== 'string') throw new Error('内容索引缺少 ID');
        ids.push(item.id);
      }
      if (ids.length >= Number(result.total)) return ids;
      if (!result.items.length) throw new Error('内容索引分页提前结束');
    }
  }
}

export function protectedReason(ctx: Context): string | undefined {
  if (ctx.record.id === referenceId) return '用户确认的优质参考场景';
  if (ctx.authoring.pinned === true) return '定稿场景';
  if (ctx.record.data.generatedRecipe !== undefined) return '已保存成片配方，需在工作台核对原参数';
  if (ctx.record.kind === 'scene' && !['nene', 'natsume', 'none'].includes(String(ctx.record.data.char)))
    return '场景角色需要单独核对，不自动选择人物';
}

export function compile(ctx: Context, data: Data, root: string, modelId: string) {
  const catalog = parsePresetCatalog(JSON.parse(fs.readFileSync(path.join(root, 'data/presets.json'), 'utf8')));
  const profile = resolveModelProfile(catalog.modelProfiles, modelId, 'anima');
  const model = models.MODELS[modelId];
  if (!profile || profile.model_id !== modelId || !model || model.family !== 'anima') throw new Error(`不支持的 Anima 模型 ${modelId}`);
  let result: ReturnType<typeof compilePromptRecipe>;
  let binding: Data = {};
  if (ctx.record.kind === 'blueprint') {
    const source = ctx.dependencies.find(item => item.kind === 'character');
    if (!source || !object(source.data) || !object(source.data.popular)) throw new Error('缺少角色绘制身份');
    const character = parsePopularCharacter({ ...source.data.popular, id: source.id,
      outfits: ctx.dependencies.filter(item => item.kind === 'outfit').map(item => object(item.data) ? item.data.outfit : null) });
    const blueprint = parseSceneBlueprint(data);
    if (!character || !blueprint) throw new Error('蓝图或人物无法编译');
    const outfit = blueprint.outfitId ? character.outfits.find(item => item.id === blueprint.outfitId) : defaultOutfit(character);
    if (!outfit) throw new Error('绑定服装不存在，停止；不会自动替换');
    result = compilePromptRecipe({ kind: 'popular', character, outfit, blueprint, engine: 'anima', profile });
    binding = endfieldAnimaBinding(character.id, 'anima', modelId) || {};
  } else {
    const scene = parsePromptScenes([data])[0];
    const character = String(scene.char);
    const choices = Object.entries(models.LORAS).filter(([, item]) => item.character === character && item.compatibleModels.includes(modelId));
    if (character !== 'none' && choices.length !== 1) throw new Error('人物 LoRA 与底模的绑定不唯一或不兼容');
    const loraId = choices[0]?.[0];
    const metadata = ctx.dependencies.find(item => item.id === 'loras')?.data;
    const loras = parsePromptLoras(metadata);
    result = compilePromptRecipe({ kind: 'studio', character, scene, engine: 'anima', profile,
      activeLoras: loraId ? { [character]: loraId } : {}, loraMeta: loras });
    if (loraId) binding = { character, loraId,
      loraStrength: parseScenePromptLoras(scene)[0]?.weight ?? 0.85 };
  }
  if (!result.prompt.trim()) throw new Error('编译后的正向提示词为空');
  const requested = String(data.recommendedSize || profile.size || '832x1216').replace('×', 'x');
  const size = /^(\d+)x(\d+)$/.exec(requested);
  if (!size) throw new Error('场景画幅格式无效');
  const ratio = Number(size[1]) / Number(size[2]);
  const selected = model.sizes.includes(requested) ? requested : [...model.sizes].sort((a, b) => {
    const [aw, ah] = a.split('x').map(Number), [bw, bh] = b.split('x').map(Number);
    return Math.abs(aw / ah - ratio) - Math.abs(bw / bh - ratio);
  })[0];
  const [width, height] = selected.split('x').map(Number);
  return { prompt: result.prompt, negative: result.negative, selections: result.selections,
    tagText: result.prompt.split('\n')[0],
    protectedTags: [...result.plan.quality, ...result.plan.rating, ...result.plan.characterTokens,
      ...result.plan.copyrightTokens, ...result.plan.artists, ...result.plan.exactControls,
      ...result.plan.preserveTokens, ...(profile.exact_tokens || []), ...(profile.negative_prefix || '').split(',')],
    payload: { modelId, prompt: result.prompt, negative: result.negative, width, height,
      steps: model.steps, cfg: model.cfg, sampler: model.sampler, scheduler: model.scheduler,
      teaCache: true, teaCacheThresh: model.teaCacheThresh ?? 0.10, ...binding }, requestedSize: requested };
}

export function changedIds(root: string, kind: Kind): string[] {
  // Read current records for identity; never infer an ID from a hashed filename.
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const tracked = execFileSync('git', ['diff', 'HEAD', '--name-only', '-z', '--', `data/catalog/${kind}`], { cwd: root, windowsHide: true });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', `data/catalog/${kind}`], { cwd: root, windowsHide: true });
  return [...new Set(Buffer.concat([tracked, untracked]).toString('utf8').split('\0').filter(Boolean).map(file => {
    if (!fs.existsSync(path.join(root, file))) return '';
    const value = record(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')));
    return value.kind === kind ? value.id : '';
  }).filter(Boolean))];
}
