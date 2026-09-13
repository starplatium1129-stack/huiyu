#!/usr/bin/env node
'use strict';

// Read-only ownership inventory. Never import builders: some --check paths self-heal.
const fs = require('fs');
const path = require('path');
const { parseManualRatings } = require('./classify-scene-ratings');
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const records = (v) => Array.isArray(v) && v.every(object);
const DOMAINS = {
  'scene-ratings': { fields: 'data/scenes rating/mature/category/usage：分级及使用元数据，不属于提示词正文', readers: ['scripts/maintenance/classify-scene-ratings.js', 'scripts/maintenance/validate-scenes.js'], writers: ['人工维护 scripts/lib/manual-scene-ratings.js', 'classify-scene-ratings.js --write'], boundary: '人工表覆盖 policy 与成熟标记，pinned 优先保留；人工审核语义与真实画面仍未验证；结构可读取不代表内容质量通过' },
  characters: { fields: 'id/name/alias/视觉DNA/性格/世界观/accent_color：展示档案；不替代热门生成身份', readers: ['src/stores/sceneStore.ts'], writers: ['人工维护 data/characters.json'], boundary: '稳定角色 ID；内容修改需编译与主力机真实画面复验' },
  popular: { fields: 'characters[].id/身份输入/outfits：服装 ID 限所属角色；分级资格独立于场景分级', readers: ['scripts/lib/popular-store.js', 'src/stores/sceneStore.ts'], writers: ['popular:build', 'popular:split'], boundary: '分片为权威源；split 是显式聚合反向导入，不能用旧聚合覆盖新源' },
  scenes: { fields: 'id/char/prompt/negative/rating/mature：通用场景；稳定 ID 与精选/退役登记关联', readers: ['scripts/lib/scene-store.js', 'src/stores/sceneStore.ts'], writers: ['data:build', 'scripts/lib/scene-store.js writeSceneShards'], boundary: 'manifest 定义逻辑组；.1 起连续批次优先；受保护场景字段遵守 pinned 基线' },
  blueprints: { fields: 'blueprints[].id/characterId/outfitId/构图及模型输入：角色蓝图', readers: ['scripts/lib/blueprint-store.js', 'src/stores/sceneStore.ts'], writers: ['blueprints:build', 'blueprints:import'], boundary: '分片为权威源；import 显式反向导入；服装按角色解析；变更需真实出图' },
  curation: { fields: 'curatedSceneIds/signatureSceneIds/personaCoreSceneIds：精选成员；qualityGate 为历史声明', readers: ['src/stores/sceneStore.ts'], writers: ['人工维护 data/curation.json'], boundary: '成员 ID 引用场景；历史审核不证明当前内容质量' },
  retired: { fields: 'records[].id/retiredAt/reason：退役记录', readers: ['scripts/maintenance/report-content-impact.js'], writers: ['人工维护 data/retired-scenes.json'], boundary: '保留稳定场景 ID 与退役原因；不据此自动删除资产' },
  references: { fields: 'standards 的 perspectives/characters/outfits；view 的角色键/outfits/references/URL/pending', readers: ['scripts/maintenance/register-pending-reference-outfits.js', 'scripts/maintenance/sync-multi-outfit-standards.js'], writers: ['reference:register', 'scripts/maintenance/sync-multi-outfit-standards.js'], boundary: 'standards 为标准；view 为合并投影且登记器也写入，不能假定为纯覆盖产物；URL/pending 不证明资产交付' },
  themes: { fields: 'data-character 选择器及 --character-*：主题颜色；与档案 accent_color 用途独立', readers: ['src/assets/css/director/tokens.css'], writers: ['人工维护 src/assets/css/director/tokens.css'], boundary: 'nene 默认主题；角色主题需双主题视觉与对比度验收' },
  showcase: { fields: '外部 manifest entries 的 id/char/type/rating/provenance：样张与审核声明', readers: ['scripts/maintenance/publish-scene-showcase-anima11.js'], writers: ['showcase:manual-review', 'showcase:scene-publish'], boundary: '外部清单位置与资产状态未知；不扫描外部路径或图片；发布/真实审核需对应机器' },
};

function reportOwnership({ root = path.resolve(__dirname, '../..'), domain } = {}) {
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
    const result = { domain: id, ...meta, machine: { report: '办公机/CI：Node，本地只读', contentAcceptance: '内容/图片质量仍待对应主力机或人工验收' }, entries: [] };
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
    return result;
  });
  return { schemaVersion: 1, root: base, domains, scope: '文件职责与浅层结构；不验证源产物一致性、字段语义、审核真实性或图片质量；writers 仅展示，未执行' };
}

function main(args = process.argv.slice(2)) {
  try {
    const opts = {};
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (['--json', '--help', '--plan'].includes(arg)) opts[arg.slice(2)] = true;
      else if (['--root', '--domain'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) opts[arg.slice(2)] = args[++i];
      else throw new Error('Invalid argument: ' + arg);
    }
    if (opts.domain && !Object.hasOwn(DOMAINS, opts.domain)) throw new Error('Unknown domain: ' + opts.domain);
    if (opts.help || opts.plan) { console.log('audit:ownership [--json] [--root <directory>] [--domain <' + Object.keys(DOMAINS).join('|') + '>]：只读归属报告；预览不读取目标'); return 0; }
    const report = reportOwnership(opts);
    console.log(opts.json ? JSON.stringify(report, null, 2) : report.domains.map((d) => `${d.domain}: ${d.fields}\n${d.entries.map((e) => `  ${e.status} ${e.path || '(external)'}${e.reason ? ' — ' + e.reason : ''}`).join('\n')}\n读取者: ${d.readers.join(', ')}\n写入入口(未执行): ${d.writers.join(', ')}\n边界: ${d.boundary}\n机器: ${d.machine.report}; ${d.machine.contentAcceptance}`).join('\n\n') + '\n' + report.scope);
    return report.domains.some((d) => d.entries.some((e) => ['missing', 'invalid'].includes(e.status))) ? 1 : 0;
  } catch (error) { console.error(error.message); return 2; }
}
if (require.main === module) process.exitCode = main();
module.exports = { reportOwnership, main };
