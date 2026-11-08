#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { RepairCatalog, changedIds, compile, hash, object, protectedReason, referenceId, type Data, type Kind } from '../lib/scene-repair-content';
import { RepairModel, validatePatch } from '../lib/scene-repair-model';
import { RepairTags } from '../lib/scene-repair-tags';
import { repairLocally, protectControls } from '../lib/scene-repair-local';
import { RepairSession, type Item } from '../lib/scene-repair-session';
import { exportSelection } from '../lib/scene-repair-export';
import { errorMessage } from '../lib/runtime-errors';
import { tagKey } from '../../src/utils/animaPromptOrder.ts';
import gateway = require('../lib/generation-gateway');

const root = path.resolve(__dirname, '../..');
const help = `content:autofix [--changed | --ids <ID,...> | --character <ID> | --all]
  [--kind blueprint|scene] [--runtime-root runtime] [--output runtime/scene-repair/automatic]
  [--model anima-miaomiao-v1.6] [--reviewer <模型>] [--concurrency 1-8] [--limit <数量>]
  [--apply] [--dry-run] [--no-model] [--online-tags] [--render] [--gateway <URL>]
默认检查 Git 改动所指向的权威库记录；本地来源词库优先，确定规则先修，模型可用时只调用一次。
--apply：自动批量预览、写回内容库并合批定向导出，不要求先出图、不逐条确认。
--online-tags：按批补查 D/G 词条，2.5 秒超时、失败熔断；未核实词保留，不妨碍确定修正。
--render：可选同种子出图复审；服务离线、失败或画面问题记入断点，批次继续；不冒称视觉通过。
--no-model：仅执行确定的本地修正。--dry-run：只读上下文与编译，无写入、无模型或外站请求。
默认 4 路处理，共享角色上下文与来源缓存；同一 output 自动复用逐条断点，已完成项不重复修改。
定稿、优质参考和已保存成片配方跳过。Ctrl+C 停止并请求取消当前出图任务。
示例：npm run wf -- content:autofix --changed --apply`;

function options() {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, ids: { type: 'string' }, changed: { type: 'boolean' }, all: { type: 'boolean' },
    character: { type: 'string' }, kind: { type: 'string', default: 'blueprint' }, 'runtime-root': { type: 'string', default: 'runtime' },
    output: { type: 'string' }, model: { type: 'string', default: 'anima-miaomiao-v1.6' }, reviewer: { type: 'string' },
    concurrency: { type: 'string', default: '4' }, limit: { type: 'string' }, gateway: { type: 'string' },
    'dry-run': { type: 'boolean' }, 'no-model': { type: 'boolean' }, 'online-tags': { type: 'boolean' }, render: { type: 'boolean' }, apply: { type: 'boolean' },
  } });
  if (values.help) return null;
  if (values.kind !== 'blueprint' && values.kind !== 'scene') throw new Error('--kind 仅支持 blueprint 或 scene');
  const selections = [values.ids !== undefined, !!values.changed, !!values.all, values.character !== undefined].filter(Boolean).length;
  if (selections > 1) throw new Error('范围只选一个：--ids、--changed、--character 或 --all');
  if (!selections) values.changed = true;
  if (values.apply && values['dry-run']) throw new Error('--apply 不能与 --dry-run 同用');
  const concurrency = Number(values.concurrency), limit = Number(values.limit ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8 || !Number.isSafeInteger(limit) || limit < 1)
    throw new Error('并发为 1–8，limit 为正整数');
  const runtime = path.resolve(root, values['runtime-root']);
  return { ...values, kind: values.kind as Kind, runtime, concurrency, limit, model: values.model!, gateway: gateway.gatewayUrl(values.gateway),
    output: path.resolve(values.output || path.join(runtime, 'scene-repair/automatic')) };
}
type Options = NonNullable<ReturnType<typeof options>>;
const sourceHash = (ctx: Item['original']) => hash({ record: ctx.record, dependencies: ctx.dependencies });
const delta = (before: Data, after: Data) => Object.fromEntries(Object.entries(after).filter(([field, value]) => hash(value) !== hash(before[field])));
const candidate = (item: Item) => item.rounds.at(-1)!;

async function main(signal: AbortSignal) {
  const opts = options();
  if (!opts) { console.log(help); return; }
  const started = Date.now(), catalog = new RepairCatalog(root, opts.runtime, signal);
  const ids = [...new Set(opts.ids !== undefined ? opts.ids.split(',').map(id => id.trim()).filter(Boolean)
    : opts.changed ? changedIds(root, opts.kind) : await catalog.select(opts.kind, opts.character))].slice(0, opts.limit);
  if (!ids.length) { console.log('没有待处理记录。'); return; }
  if (opts['dry-run']) {
    for (const id of ids) {
      const ctx = await catalog.context(opts.kind, id), reason = protectedReason(ctx);
      const plan = reason ? undefined : compile(ctx, ctx.record.data, root, opts.model);
      console.log(`${id}: ${reason ? `跳过（${reason}）` : `可检查，编译 ${plan!.payload.width}x${plan!.payload.height}`}`);
    }
    return;
  }
  const session = new RepairSession(opts.output, opts.runtime, { version: 2, root, runtime: opts.runtime, kind: opts.kind,
    model: opts.model, reviewer: opts.reviewer || process.env.VISION_MODEL || 'gemini-3.7-flash-high', render: !!opts.render, gateway: opts.gateway,
    online: !!opts['online-tags'], policy: hash(['content', 'local', 'tags', 'model'].map(name =>
      fs.readFileSync(path.join(root, `scripts/lib/scene-repair-${name}.ts`), 'utf8'))) });
  try {
    const tagsRecord = await catalog.read<unknown[]>('document', 'tags');
    let cache: unknown;
    try { cache = JSON.parse(fs.readFileSync(path.join(opts.output, 'tag-cache.json'), 'utf8')); } catch { /* New local cache. */ }
    const tags = new RepairTags(tagsRecord.data, signal, (label, value) => session.raw(label, value), !!opts['online-tags'], cache);
    const model = new RepairModel(opts.reviewer, signal, (label, value) => session.raw(label, value));
    const modelAvailable = !opts['no-model'] && await model.available();
    let reference: Data | undefined;
    if (modelAvailable) {
      try { reference = (await catalog.read('blueprint', referenceId)).data; } catch { /* Reference is optional. */ }
    }
    console.log(`处理 ${ids.length} 条，${opts.concurrency} 路；${modelAvailable ? '按需单次模型纠正' : '本地快速纠正，模型步骤待补'}；${opts['online-tags'] ? '可选批量联网' : '使用本地 D/G 来源词库'}`);
    const prepared = new Map<string, Item>(), exports = new Map<string, Item>();
    let cursor = 0, kept = 0, deferred = 0;
    await Promise.all(Array.from({ length: Math.min(opts.concurrency, ids.length) }, async () => {
      while (cursor < ids.length) {
        signal.throwIfAborted();
        const id = ids[cursor++], slot = `${opts.kind}:${id}`;
        try {
          const ctx = await catalog.context(opts.kind, id), reason = protectedReason(ctx);
          if (reason) { kept++; console.log(`[跳过] ${id}：${reason}`); continue; }
          let previous = session.get(slot);
          if (previous?.applying && ctx.record.revision === previous.applying.expectedRevision + 1 && hash(ctx.record.data) === previous.applying.dataHash) {
            previous.appliedRevision = ctx.record.revision; previous.status = 'applied'; session.save(slot);
          }
          if (previous?.appliedRevision === ctx.record.revision && hash(candidate(previous).data) === hash(ctx.record.data)) {
            if (!previous.exported) exports.set(slot, previous);
            if (opts.render && !candidate(previous).visual) await supplementVisual(previous, slot, opts, session, model, signal);
            if (previous.semantic || !modelAvailable) { kept++; console.log(`[复用] ${id}：修正已应用`); continue; }
            previous = undefined;
          }
          const fingerprint = sourceHash(ctx), baseline = compile(ctx, ctx.record.data, root, opts.model);
          if (previous?.sourceHash === fingerprint && hash(previous.baseline) === hash(baseline)
            && (previous.semantic || !modelAvailable)) {
            if (opts.render && previous.rounds.length && !candidate(previous).visual)
              await supplementVisual(previous, slot, opts, session, model, signal);
            if (previous.rounds.length && !previous.appliedRevision) prepared.set(slot, previous);
            else kept++;
            console.log(`[复用] ${id}：已有断点`); continue;
          }
          const originalTags = await tags.scan(opts.kind, ctx.record.data, baseline);
          const local = repairLocally(opts.kind, ctx.record.data, tags, baseline.protectedTags);
          let data = { ...ctx.record.data, ...local.patch }, diagnosis = local, semantic = false;
          const notes: string[] = [];
          if (modelAvailable && await model.available() && (local.verdict === 'repair' || originalTags.bad.length)) {
            try {
              const localPlan = compile(ctx, data, root, opts.model);
              const outfitId = String(ctx.record.data.outfitId || '');
              const dependencies = ctx.dependencies.filter(dep => dep.kind !== 'outfit' || !outfitId || dep.id.endsWith(`/${outfitId}`));
              const answer = await model.diagnose(`${id}-diagnose`, opts.kind, data, {
                originalIntent: ctx.record.data, current: data, compiled: localPlan, characterAndOutfits: dependencies,
                unresolved: originalTags.bad, allowedTags: tags.vocabulary(originalTags.bad.map(tag => tag.token)), qualityReference: reference,
                instruction: '只修明确冲突。优先使用已核实词表的等义标签；未知词查不到不等于自创，不能猜删。细节关系保留在自然语言。',
              });
              semantic = true;
              if (answer.verdict === 'repair') {
                const proposed = { ...data, ...answer.patch };
                protectControls(opts.kind, ctx.record.data, proposed, baseline.protectedTags);
                const plan = compile(ctx, proposed, root, opts.model), scan = await tags.scan(opts.kind, proposed, plan);
                const existing = new Set(originalTags.bad.map(tag => tagKey(tag.token)));
                if (scan.bad.some(tag => !existing.has(tagKey(tag.token)))) notes.push('模型引入未核实词，已舍弃该建议并保留本地修正');
                else { data = proposed; diagnosis = { verdict: 'repair', patch: delta(ctx.record.data, data), issues: [...local.issues, ...answer.issues] }; }
              } else if (answer.verdict === 'uncertain') notes.push('语义不确定，保留本地确定修正');
            } catch (error) { signal.throwIfAborted(); notes.push(`模型步骤待补：${errorMessage(error)}`); }
          } else if (!modelAvailable) notes.push('模型不可用，已执行本地确定修正');
          protectControls(opts.kind, ctx.record.data, data, baseline.protectedTags);
          const patch = validatePatch(opts.kind, ctx.record.data, delta(ctx.record.data, data));
          const plan = compile(ctx, data, root, opts.model), scan = await tags.scan(opts.kind, data, plan);
          if (scan.bad.length) notes.push(`${scan.bad.length} 个词未核实，原样保留，后续补查`);
          const item: Item = { sourceHash: fingerprint, original: ctx, baseline, tags: originalTags, rounds: [],
            status: Object.keys(patch).length ? 'prepared' : 'kept', semantic, notes };
          if (Object.keys(patch).length) item.rounds.push({ data, compiled: plan, diagnosis, tags: scan });
          session.set(slot, item);
          if (item.rounds.length) {
            if (opts.render) await supplementVisual(item, slot, opts, session, model, signal);
            prepared.set(slot, item);
            console.log(`[已纠正] ${id}：${Object.keys(patch).join(', ')}${notes.length ? '；部分补充步骤待办' : ''}`);
          } else { kept++; console.log(`[保持] ${id}${scan.bad.length ? '；未知词保留' : ''}`); }
        } catch (error) { signal.throwIfAborted(); deferred++; console.error(`[稍后处理] ${id}：${errorMessage(error)}`); }
      }
    }));
    session.write('tag-cache.json', tags.snapshot());
    if (opts.apply && prepared.size) {
      catalog.invalidate();
      const fresh: Array<[string, Item]> = [];
      for (const [slot, item] of prepared) {
        try {
          const current = await catalog.context(opts.kind, item.original.record.id);
          if (protectedReason(current) || sourceHash(current) !== item.sourceHash
            || hash(compile(current, candidate(item).data, root, opts.model)) !== hash(candidate(item).compiled))
            throw new Error('内容或关联资料已变化，本条留到下次，不覆盖新修改');
          fresh.push([slot, item]);
        } catch (error) { signal.throwIfAborted(); deferred++; console.error(`[稍后处理] ${slot}：${errorMessage(error)}`); }
      }
      for (let offset = 0; offset < fresh.length; offset += 25)
        await applyBatch(fresh.slice(offset, offset + 25), opts, catalog, session, exports);
    }
    if (opts.apply && exports.size) {
      let selected: string[] = [], length = 0;
      const flush = async () => {
        if (!selected.length) return;
        try {
          const published = await exportSelection(catalog, selected, exports, opts.output);
          for (const slot of published) { const item = exports.get(slot)!; item.exported = true; session.save(slot); }
        } catch (error) { signal.throwIfAborted(); console.error(`[导出待补] 内容库已修正：${errorMessage(error)}`); }
        selected = []; length = 0;
      };
      for (const slot of exports.keys()) {
        if (length + slot.length > 16000) await flush();
        selected.push(slot); length += slot.length + 12;
      }
      await flush();
    }
    console.log(`完成：${opts.apply ? `${exports.size} 条已写回` : `${prepared.size} 条候选`}，${kept} 条保持，${deferred} 条稍后处理；用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒。`);
  } finally { session.close(); }
}

async function supplementVisual(item: Item, slot: string, opts: Options, session: RepairSession, model: RepairModel, signal: AbortSignal) {
  try {
    if (!await model.available()) throw new Error('视觉模型不可用');
    const response = await fetch(`${opts.gateway}/api/anima/status`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) });
    const status: unknown = await response.json();
    if (!response.ok || !object(status) || status.online !== true) throw new Error('出图服务未就绪');
    const before = await session.render(item, item.baseline, slot, 0, opts.gateway, signal);
    const after = await session.render(candidate(item), candidate(item).compiled, slot, 1, opts.gateway, signal);
    candidate(item).visual = await model.visual(`${slot}-visual`, { original: item.original.record.data, candidate: candidate(item).data }, [before, after]);
    item.notes.push(`补充视觉结论：${candidate(item).visual!.verdict}`);
    console.log(`[画面复审] ${slot}：${candidate(item).visual!.verdict}`);
  } catch (error) { signal.throwIfAborted(); item.notes.push(`出图复审待补：${errorMessage(error)}`); }
  item.notes = [...new Set(item.notes)];
  session.save(slot);
}

async function applyBatch(batch: Array<[string, Item]>, opts: Options, catalog: RepairCatalog, session: RepairSession, exports: Map<string, Item>): Promise<void> {
  if (!batch.length) return;
  const changes = batch.map(([, item]) => ({ kind: opts.kind, id: item.original.record.id, expectedRevision: item.original.record.revision,
    patch: validatePatch(opts.kind, item.original.record.data, delta(item.original.record.data, candidate(item).data)) }));
  const file = `patch-${hash(changes).slice(0, 24)}.json`;
  session.write(file, { changes });
  try {
    await catalog.call('patch', ['--file', path.join(opts.output, file)]);
    for (const [slot, item] of batch) {
      item.applying = { expectedRevision: item.original.record.revision, dataHash: hash(candidate(item).data) }; session.save(slot);
    }
    const receipt = await catalog.call('patch', ['--file', path.join(opts.output, file), '--apply']);
    session.raw('patch-applied', receipt);
  } catch (error) {
    catalog.signal.throwIfAborted();
    // Split only a failed transaction, so one conflict cannot hold up the other records.
    const remaining: Array<[string, Item]> = [];
    for (const [slot, item] of batch) {
      try {
        const saved = await catalog.read(opts.kind, item.original.record.id);
        if (item.applying && saved.revision === item.applying.expectedRevision + 1 && hash(saved.data) === item.applying.dataHash) {
          item.appliedRevision = saved.revision; item.status = 'applied'; exports.set(slot, item); session.save(slot);
        } else remaining.push([slot, item]);
      } catch { catalog.signal.throwIfAborted(); remaining.push([slot, item]); }
    }
    if (remaining.length > 1) {
      const middle = Math.ceil(remaining.length / 2);
      await applyBatch(remaining.slice(0, middle), opts, catalog, session, exports);
      await applyBatch(remaining.slice(middle), opts, catalog, session, exports);
    } else if (remaining.length) console.error(`[稍后处理] ${remaining[0][0]}：${errorMessage(error)}`);
    return;
  }
  for (const [slot, item] of batch) {
    try {
      const saved = await catalog.read(opts.kind, item.original.record.id);
      if (hash(saved.data) !== hash(candidate(item).data)) throw new Error('写回内容与候选不一致');
      item.appliedRevision = saved.revision; item.status = 'applied'; exports.set(slot, item); session.save(slot);
    } catch (error) { catalog.signal.throwIfAborted(); console.error(`[写回核对待补] ${slot}：${errorMessage(error)}`); }
  }
}

if (require.main === module) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('用户取消'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  void main(controller.signal).catch(error => { console.error(errorMessage(error)); process.exitCode = controller.signal.aborted ? 130 : 1; })
    .finally(() => { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); });
}
