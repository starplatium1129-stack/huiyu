#!/usr/bin/env node
'use strict';

// Read-only ownership inventory. Never import builders: some --check paths self-heal.
const fs = require('fs');
const path = require('path');
const { parseManualRatings } = require('./classify-scene-ratings');
const { localReader } = require('../lib/content-history-reader');
const { inspectDomain, summarizeConsistency } = require('../lib/content-impact-consistency');
const { FIELD_VALIDATION } = require('../lib/content-impact-checks');
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const records = (v) => Array.isArray(v) && v.every(object);
const DOMAINS = {
  'scene-ratings': { fields: 'data/scenes rating/mature/category/usage：分级及使用元数据，不属于提示词正文', readers: ['scripts/maintenance/classify-scene-ratings.js', 'scripts/maintenance/validate-scenes.js'], writers: ['人工维护 scripts/lib/manual-scene-ratings.js', 'classify-scene-ratings.js --write'], boundary: '人工表覆盖 policy 与成熟标记，pinned 优先保留；人工审核语义与真实画面仍未验证；结构可读取不代表内容质量通过' },
  characters: { fields: 'id/name/alias/voice（缺省回落 speech）/tags/bg_story/personality/likes/identity/portrait/lora：详情与聊天设定档案；详情解析不输出 traits/visual_dna/accent_color；traits 另由提示词组装消费', readers: ['src/stores/sceneStore.ts（原始记录入 store）', 'src/utils/characterProfiles.ts parseCharacterProfiles → src/views/CharacterView.vue（只渲染解析器输出的显式字段）', 'src/utils/characterSettingMemory.ts parseRecord（聊天设定记忆取 bg_story/personality/likes/speech/identity）', 'src/composables/prompt/usePromptAssembly.ts currentTraits（读取 traits 并参与提示词组装）', 'scripts/maintenance/validate-content-contracts.js（契约校验）', 'scripts/maintenance/report-content-coverage.js（仅读 accent_color 做主题覆盖报告，不与 tokens.css 比对）'], writers: ['人工维护 data/characters.json', '保存链 scripts/lib/scene-write.js cleanOrphanedSceneRefs（POST /api/maintenance/scenes 后自动清洗 lora.recommended_scene 悬空引用）'], boundary: '稳定角色 ID，与热门分片角色 id 同名对齐；详情页只渲染解析器输出的显式字段，JSON 字段存在不代表详情页展示；普通档案文字按资料维护验收，涉及提示词输入的字段变更仍需编译与真实画面复验' },
  popular: { fields: 'characters[].id/outfits（name/prose/tokens/default）/identityTokens/exactTokens/engines/adultEligibility：生成身份输入；服装按（角色 id, 服装 id）复合键定位，跨角色可重名', readers: ['scripts/lib/popular-store.js loadPopularShards（build 与启动自愈的分片聚合读取入口）', 'src/stores/sceneStore.ts → src/utils/popularContent.ts parsePopularCharacters（浏览器只读聚合；parseOutfit 只保留 default，丢弃分片 isDefault）'], writers: ['人工维护 data/popular/ 分片', 'popular:build（分片→聚合）', 'popular:split（聚合→分片反向导入）', '启动自愈 scripts/lib/ensure-data-build.js（聚合陈旧/缺失时按分片重建）'], boundary: '分片为权威源，手改聚合会在重启时被分片重建覆盖；split 是显式反向导入，不能用旧聚合覆盖新源；运行时 defaultOutfit 取 default 否则首套，分片 isDefault 是不进运行时的冗余副本；characters.json 展示档案与本域生成身份用途独立，同名字段不机械合并' },
  scenes: { fields: 'id/char/prompt/negative/rating/mature：通用场景；稳定 ID 与精选/退役登记关联', readers: ['scripts/lib/scene-store.js loadSceneShards', 'src/stores/sceneStore.ts', 'routes/maintenance-scene-state.js'], writers: ['data:build → scripts/maintenance/build-scenes.js（聚合/浏览器分片/core/index；--check 也可能自愈写入）', 'scripts/lib/scene-write.js applySceneChanges（保留现有批次的增量源写入）', 'scripts/lib/scene-store.js writeSceneShards（显式全量重切）', 'routes/maintenance-scene-save.js（变更集/全量导入保存链）'], boundary: 'manifest 定义逻辑组；只读报告拒绝批次缺号/并存/孤立文件，不把连续前缀当完整源；受保护场景字段遵守 pinned 基线；报告不执行保存或构建' },
  blueprints: { fields: 'blueprints[].id/characterId/outfitId/adult/prompt 输入：角色蓝图；outfitId 按所属角色热门服装解析', readers: ['scripts/lib/blueprint-store.js loadBlueprintShards（build/import/自愈/受控补丁共用入口）', 'src/stores/sceneStore.ts → src/utils/popularContent.ts parseSceneBlueprints（浏览器读聚合）', 'scripts/lib/blueprint-write.js prepareBlueprintWrite（保存前读取分片及字节基线）'], writers: ['blueprints:build（分片→聚合）', 'blueprints:import（聚合→分片后重建聚合）', 'UI 保存 routes/maintenance-scene-save.js → routes/maintenance-content-products.js → scripts/lib/blueprint-write.js applyBlueprintWrite（分片/manifest/聚合；统一快照回滚由保存路由负责）', 'scripts/maintenance/apply-scene-patch.js（受控补丁写分片后重建聚合）', '启动自愈 scripts/lib/ensure-data-build.js（聚合与分片不一致时按分片重建）'], boundary: '分片为权威源；当前保存链已调用分片准备/基线复核/应用，后续压缩伴生文件及 DATA_VERSION 刷新属于路由事务；本报告不验证事务或真实设备验收。重启自愈仍以分片为准；悬空 outfitId 运行时回退默认服装；变更需真实出图' },
  curation: { fields: 'curatedSceneIds/signatureSceneIds/personaCoreSceneIds：精选成员；qualityGate 为历史声明', readers: ['src/stores/sceneStore.ts', 'scripts/lib/scene-store.js readCuration/writeCoreAndIndex'], writers: ['人工维护 data/curation.json', 'routes/maintenance-scene-save.js（显式保存 curation）', 'scripts/lib/scene-write.js cleanOrphanedSceneRefs（保存后清洗悬空 ID）'], boundary: '成员 ID 引用场景；personaCoreSceneIds 派生 core/index；历史审核不证明当前内容质量' },
  retired: { fields: 'records[].id/retiredAt/reason：退役记录', readers: ['scripts/maintenance/report-content-impact.js', 'scripts/lib/scene-write.js readRetiredSceneIds（分配/保存排除退役 ID）'], writers: ['人工维护 data/retired-scenes.json', 'scripts/lib/scene-write.js retireRemovedScenes（保存删除时登记）'], boundary: '保留稳定场景 ID 与退役原因；本只读报告不执行退役写入或资产清理' },
  references: { fields: 'standards 的 perspectives/characters/outfits；view 的角色键/outfits/isDefault/references/URL/pending', readers: ['scripts/maintenance/register-pending-reference-outfits.js（读 standards/view/popular 补登 pending）', 'src/utils/characterReferenceData.ts（前端懒加载 view，默认形态取 isDefault）', 'scripts/tests/test-character-reference-contract.js（standards/view 镜像契约）'], writers: ['人工维护 data/character-reference-standards.json（注意 sync 会全量覆写本文件，手改前先核对）', 'scripts/maintenance/sync-multi-outfit-standards.js（standards 全量覆写；view 按 Object.assign 合并写入，不整库覆盖）', 'reference:register（workflow 登记 → scripts/maintenance/register-pending-reference-outfits.js，standards 与 view 双写）'], boundary: 'view 是合并投影且登记器也写入，不是纯覆盖产物，从源删除的角色不会自动从 view 消失；view 的 isDefault 由 popular default 派生（o.default || idx===0，首套无条件标记）；sync 按磁盘四机位 PNG 齐全过滤形态，缺素材机器运行会写出空 outfits 条目；isNsfw 名称启发式只打标不过滤；URL/pending 不证明资产交付或审核' },
  themes: { fields: 'data-character 选择器及 --character-* 变量：主题颜色令牌', readers: ['src/assets/css/director.css（@import 引入 tokens.css）', '消费 var(--character-*) 的样式与组件（chat.css、director/*、companion.css、light-theme.css 等）'], writers: ['人工维护 src/assets/css/director/tokens.css'], boundary: '主题渲染以实际 CSS 为准；与 characters.json accent_color 无代码比对，颜色值不同不判为数据冲突；nene 默认主题；角色主题需双主题视觉与对比度验收' },
  showcase: { fields: '外部 manifest entries 的 id/char/type/rating/provenance：样张与审核声明', readers: ['scripts/maintenance/publish-scene-showcase-anima11.js'], writers: ['showcase:manual-review', 'showcase:scene-publish'], boundary: '外部清单位置与资产状态未知；不扫描外部路径或图片；发布/真实审核需对应机器' },
};

const FIELD_CONTRACTS = {
  popular: { source: 'data/popular/manifest.json + declared shards: characters[]', derived: ['data/popular-characters.json'],
    rule: 'popular-store.loadPopularShards/writePopularAggregate: concatenate records in manifest/file order, wrap {version:1, characters}; all record fields copied',
    implementation: ['scripts/lib/popular-store.js'], unknown: ['browser parse-field losses', 'compressed files', 'DATA_VERSION'] },
  blueprints: { source: 'data/blueprints/manifest.json + declared shards: blueprints[]', derived: ['data/scene-blueprints.json'],
    rule: 'blueprint-store.loadBlueprintShards/writeBlueprintAggregate: concatenate in manifest/file order, wrap {version:2, blueprints}; all record fields copied',
    implementation: ['scripts/lib/blueprint-store.js', 'scripts/lib/blueprint-write.js', 'routes/maintenance-content-products.js'], unknown: ['save transaction acceptance', 'compressed files', 'DATA_VERSION'] },
  scenes: { source: 'data/scenes/manifest.json + complete canonical batches; data/curation.json personaCoreSceneIds',
    derived: ['data/scenes.json', 'data/scenes-nene.json', 'data/scenes-natsume.json', 'data/scenes-shared.json', 'data/scenes-core.json', 'data/scenes-index.json'],
    rule: 'scene-store sorts numeric IDs; browser groups natsume/triad/other into natsume/shared/nene with ID deduplication; core takes first 2000 declared IDs that exist; index projects counts, orderedIds and core IDs',
    implementation: ['scripts/lib/scene-store.js', 'scripts/maintenance/build-scenes.js'], unknown: ['compressed files', 'DATA_VERSION', 'rating policy semantics', 'compiled prompt/rendering'] },
  references: { source: 'data/character-reference-standards.json', derived: ['data/character-reference-view.json'],
    rule: 'sync-multi-outfit-standards maps characterId/displayName/source/identityProse, outfit id/name/prose/Boolean flags and ordered perspective metadata; register-pending-reference-outfits also writes both documents',
    implementation: ['scripts/maintenance/sync-multi-outfit-standards.js', 'scripts/maintenance/register-pending-reference-outfits.js', 'scripts/tests/test-character-reference-contract.js'],
    unknown: ['popular-to-standards: heroine constants/asset filtering', 'merge-writer history', 'URL/fileName/pending/review', 'asset existence'] },
  curation: { source: 'data/curation.json', derived: ['data/scenes-core.json', 'data/scenes-index.json'],
    rule: 'scene-store.readCuration/tierIds/writeCoreAndIndex consume personaCoreSceneIds; curated/signature membership is separately read by sceneStore',
    implementation: ['scripts/lib/scene-store.js', 'src/stores/sceneStore.ts'], unknown: ['historical qualityGate/review validity', 'rendered ordering'] },
};

function reportOwnership({ root = path.resolve(__dirname, '../..'), domain, consistency = false } = {}) {
  if (domain && !Object.hasOwn(DOMAINS, domain)) throw new Error('Unknown domain: ' + domain);
  const base = fs.realpathSync(root);
  const inside = (target) => { const rel = path.relative(base, target); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep); };
  function safe(file) {
    const target = path.resolve(base, file);
    if (!inside(target)) throw new Error('Path outside root');
    // Check each existing parent before accessing its descendants, including junctions.
    let current = base;
    for (const part of path.relative(base, target).split(path.sep)) {
      current = path.join(current, part);
      if (!inside(fs.realpathSync(current))) throw new Error('Real path outside root');
    }
    return target;
  }
  function inspect(file, role, validate, text = false) {
    const row = { path: file, role, status: role, quality: 'unverified' };
    let value;
    try {
      const target = safe(file);
      if (!fs.statSync(target).isFile()) throw new Error('Not a regular file');
      const raw = fs.readFileSync(target, 'utf8');
      value = text ? raw : JSON.parse(raw);
      if (!validate(value)) throw new Error('Invalid structure');
      row.observedFields = text ? [...new Set(raw.match(/--character-[a-z-]+/g) || [])].sort() : Object.keys(value).filter((key) => !Array.isArray(value) || Number.isNaN(Number(key)));
      const items = Array.isArray(value) ? value : value.characters || value.blueprints || value.records;
      if (Array.isArray(items)) {
        row.count = items.length;
        row.entityFields = [...new Set(items.flatMap((item) => object(item) ? Object.keys(item) : []))].sort();
      }
    } catch (error) {
      row.status = error.code === 'ENOENT' ? 'missing' : 'invalid';
      row.reason = error.message;
      value = undefined;
    }
    return { row, value };
  }
  const domains = Object.entries(DOMAINS).filter(([id]) => !domain || id === domain).map(([id, meta]) => {
    const result = { domain: id, ...meta, fieldContract: FIELD_CONTRACTS[id] || { status: 'unknown', reason: '未追踪本域全部字段的 source/derived 映射；不把独立用途的同名字段视为镜像' },
      consistency: { status: 'not-run', reason: 'Use --consistency for pure JSON/field projection checks' },
      fieldValidation: { status: 'not-run', ...(FIELD_VALIDATION[id] || { rules: [], unknown: ['No complete exported field predicate for this domain'] }),
        execution: 'scripts/maintenance/check-content-impact.js --full --execute; partial field coverage remains explicit' },
      readWriteCoverage: { status: 'partial', completeness: 'unknown', basis: 'Only listed implementation readers/writers; no exhaustive dependency claim' },
      machine: { report: '办公机/CI：Node，本地只读', contentAcceptance: '内容/图片质量仍待对应主力机或人工验收' }, entries: [] };
    const add = (...args) => { const item = inspect(...args); result.entries.push(item.row); return item; };
    if (['popular', 'scenes', 'blueprints'].includes(id)) {
      const directory = 'data/' + id;
      const key = id === 'popular' ? 'characters' : 'blueprints';
      const shape = id === 'scenes' ? records : (v) => object(v) && records(v[key]);
      const validManifest = (v) => object(v) && Array.isArray(v.files) && v.files.length > 0 && v.files.every((e) => object(e) && typeof e.file === 'string' && /^[^/\\:]+\.json$/.test(e.file) && e.file !== 'manifest.json') && new Set(v.files.map((e) => e.file)).size === v.files.length;
      const manifest = add(directory + '/manifest.json', 'source', validManifest).value;
      if (manifest) for (const entry of manifest.files) {
        let files = [entry.file];
        if (id === 'scenes') {
          try {
            const names = fs.readdirSync(safe(directory));
            const stem = entry.file.slice(0, -5);
            if (names.includes(stem + '.1.json')) {
              files = [];
              for (let n = 1; names.includes(stem + '.' + n + '.json'); n++) files.push(stem + '.' + n + '.json');
            }
          } catch (error) { result.entries.push({ path: directory, role: 'source', status: 'invalid', reason: error.message, quality: 'unverified' }); files = []; }
        }
        for (const file of files) { const item = add(directory + '/' + file, 'source', shape); item.row.logicalGroup = entry.file; }
      }
      const product = { popular: 'popular-characters.json', scenes: 'scenes.json', blueprints: 'scene-blueprints.json' }[id];
      add('data/' + product, 'product', shape);
      if (id === 'scenes') {
        for (const file of ['scenes-nene.json', 'scenes-natsume.json', 'scenes-shared.json', 'scenes-core.json']) add('data/' + file, 'product', records);
        add('data/scenes-index.json', 'product', (v) => object(v) && object(v.shards) && Number.isInteger(v.total));
      }
    } else if (id === 'scene-ratings') {
      add('scripts/lib/manual-scene-ratings.js', 'source', (raw) => { parseManualRatings(raw); return true; }, true);
      add('scripts/maintenance/classify-scene-ratings.js', 'source', (raw) => raw.trim().length > 0, true);
      const scenes = reportOwnership({ root: base, domain: 'scenes' }).domains[0];
      result.entries.push(...scenes.entries.filter((e) => e.logicalGroup).map((e) => ({ ...e, role: 'product', status: e.status === 'source' ? 'product' : e.status, fields: ['rating', 'mature', 'category', 'usage'] })));
      result.entries.push(...scenes.entries.filter((e) => e.path === 'data/scenes/manifest.json'));
    } else if (id === 'characters') add('data/characters.json', 'source', records);
    else if (id === 'curation') add('data/curation.json', 'source', (v) => object(v) && ['curatedSceneIds', 'signatureSceneIds', 'personaCoreSceneIds'].every((key) => Array.isArray(v[key]) && v[key].every((x) => typeof x === 'string')));
    else if (id === 'retired') add('data/retired-scenes.json', 'source', (v) => object(v) && records(v.records) && v.records.every((r) => typeof r.id === 'string'));
    else if (id === 'references') {
      add('data/character-reference-standards.json', 'source', (v) => object(v) && records(v.characters) && records(v.perspectives));
      add('data/character-reference-view.json', 'product', (v) => object(v) && Object.values(v).every((r) => object(r) && records(r.outfits)));
    } else if (id === 'themes') add('src/assets/css/director/tokens.css', 'source', (v) => v.includes('--character-') && v.includes('{') && v.includes('}'), true);
    else result.entries.push({ path: null, role: 'source', status: 'external-unknown', reason: '外部样张 manifest 未定位；未读取外部文件', quality: 'unverified' });
    if (consistency) {
      if (['popular', 'blueprints', 'scenes', 'references', 'curation'].includes(id)) {
        const reader = localReader(base);
        const snapshot = inspectDomain(reader, id === 'curation' ? 'scenes' : id);
        result.consistency = summarizeConsistency(snapshot);
        result.consistency.evidence = [...reader.evidence.values()];
        const changed = reader.verify();
        result.consistency.unknown.push(...changed);
        if (changed.length) result.consistency.status = 'unknown';
      } else result.consistency = { status: 'unknown', reason: 'No implemented pure source/derived mapping for this domain; shallow structure is not consistency evidence' };
    }
    return result;
  });
  return { schemaVersion: 2, root: base, domains, scope: '文件职责与浅层结构；readers/writers 为按实现核对的静态说明，不加载或执行所列写者，也不声称穷尽所有读写者。'
    + (consistency ? '本次额外只读比较 fieldContract 声明的 JSON/字段投影及数组顺序；序列化差异单列，未追踪映射为 unknown。' : '未启用 --consistency，不验证源产物一致性。')
    + '不证明字段语义、审核真实性或图片质量；局部通过不等于全库通过。' };
}

function main(args = process.argv.slice(2)) {
  try {
    const opts = {};
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (['--json', '--help', '--plan', '--consistency'].includes(arg)) opts[arg.slice(2)] = true;
      else if (['--root', '--domain'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) opts[arg.slice(2)] = args[++i];
      else throw new Error('Invalid argument: ' + arg);
    }
    if (opts.domain && !Object.hasOwn(DOMAINS, opts.domain)) throw new Error('Unknown domain: ' + opts.domain);
    if (opts.help || opts.plan) { console.log('audit:ownership [--json] [--consistency] [--root <directory>] [--domain <' + Object.keys(DOMAINS).join('|') + '>]：只读归属报告；--consistency 比较已实现字段投影，不执行构建；unknown/mismatch 退出 1。预览不读取目标'); return 0; }
    const report = reportOwnership(opts);
    console.log(opts.json ? JSON.stringify(report, null, 2) : report.domains.map((d) => `${d.domain}: ${d.fields}\n${d.entries.map((e) => `  ${e.status} ${e.path || '(external)'}${e.reason ? ' — ' + e.reason : ''}`).join('\n')}\n读取者: ${d.readers.join(', ')}\n写入入口(未执行): ${d.writers.join(', ')}\n字段映射: ${JSON.stringify(d.fieldContract)}\n一致性: ${JSON.stringify(d.consistency)}\n边界: ${d.boundary}\n机器: ${d.machine.report}; ${d.machine.contentAcceptance}`).join('\n\n') + '\n' + report.scope);
    return report.domains.some((d) => d.entries.some((e) => ['missing', 'invalid'].includes(e.status))
      || (opts.consistency && ['unknown', 'mismatch'].includes(d.consistency.status))) ? 1 : 0;
  } catch (error) { console.error(error.message); return 2; }
}
if (require.main === module) process.exitCode = main();
module.exports = { reportOwnership, main };
