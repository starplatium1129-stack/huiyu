import type { RegisteredWorkflows } from './workflow-types';

// Kept for supported pre-catalog upgrade sources; remove with that source support.
export const LEGACY_WORKFLOWS: RegisteredWorkflows = {
  'legacy:scenes:patch': {
    desc: '旧格式场景/蓝图补丁；已迁移项目使用 content:catalog patch/import',
    cmd: ['node', 'scripts/maintenance/apply-scene-patch.js'], opts: '--patch <JSON> [--apply] [--out <新报告>]', required: ['--patch'], docs: 'docs/maintenance.md#迁移与保护',
    run: { nature: ['preview', 'guard'], machine: ['node'], switches: { '--apply': ['writes-source', 'writes-product'], '--out': ['writes-product'] }, resume: 'idempotent', evidence: 'scripts/maintenance/apply-scene-patch.ts main', unknown: [], notes: ['仅修复未迁移旧资料；已迁移工作库使用 content:catalog 并显式 export，旧写入守卫仍拒绝回写'] },
  },
  'legacy:popular:split': {
    desc: '旧格式专用（已迁移项目拒绝）：popular→分片（仅写分片文件，不重建聚合；如需重建用 legacy:popular:import）',
    cmd: ['node', 'scripts/maintenance/split-popular.js', '--write'],
    docs: 'docs/maintenance.md',
    run: { nature: ['guard'], machine: ['node'], switches: { '--write': ['writes-source'] }, resume: 'idempotent', evidence: 'scripts/maintenance/split-popular.js:4-6', unknown: [], notes: ['缺 --write 直接拒绝退出 1；注册命令已固定 --write'] },
  },
  'legacy:popular:import': {
    desc: '旧格式专用（已迁移项目拒绝）：popular→分片+重建聚合（legacy:popular:split 超集，从聚合文件导入；改分片用 build）',
    cmd: ['npm', 'run', 'legacy:popular:import'],
    docs: 'docs/maintenance.md',
    run: { nature: ['writes-source', 'writes-product'], machine: ['node'], switches: {}, resume: 'idempotent', evidence: 'package.json scripts.legacy:popular:import（split-popular --write && build-popular）', unknown: [], notes: ['从聚合反向覆盖分片，先核对 diff'] },
  },
  'legacy:blueprints:split': {
    desc: '旧格式专用（已迁移项目拒绝）：blueprints→分片（仅写分片文件，不重建聚合；如需重建用 legacy:blueprints:import）',
    cmd: ['node', 'scripts/maintenance/split-blueprints.js', '--write'],
    docs: 'docs/maintenance.md',
    run: { nature: ['guard'], machine: ['node'], switches: { '--write': ['writes-source'] }, resume: 'idempotent', evidence: 'scripts/maintenance/split-blueprints.js:11-13', unknown: [] },
  },
  'legacy:blueprints:import': {
    desc: '旧格式专用（已迁移项目拒绝）：blueprints→分片+重建聚合（legacy:blueprints:split 超集，从聚合文件导入；改分片用 build）',
    cmd: ['npm', 'run', 'legacy:blueprints:import'],
    docs: 'docs/maintenance.md',
    run: { nature: ['writes-source', 'writes-product'], machine: ['node'], switches: {}, resume: 'idempotent', evidence: 'package.json scripts.legacy:blueprints:import（split-blueprints --write && build-blueprints）', unknown: [] },
  },
  'legacy:scenes:import': {
    desc: '旧格式专用（已迁移项目拒绝）：scenes.json -> 分片 + 重建聚合（覆盖写入）',
    cmd: ['npm', 'run', 'legacy:scenes:import'],
    docs: 'docs/maintenance.md',
    run: { nature: ['writes-source', 'writes-product'], machine: ['node'], switches: {}, resume: 'idempotent', evidence: 'package.json scripts.legacy:scenes:import（split-scenes --write && build-scenes）', unknown: [], notes: ['writeSceneShards 按 ID 排序重切全部分组，中间插入/退役会移动后续批次条目（计划 006 D5）'] },
  },
  'legacy:scenes:normalize': {
    desc: '旧格式专用（已迁移项目拒绝）：分类评级 + 规范标签 + 校验',
    cmd: ['npm', 'run', 'legacy:scenes:normalize'],
    docs: 'package.json',
    run: { nature: ['writes-source'], machine: ['node'], switches: {}, resume: 'idempotent', evidence: 'package.json scripts.legacy:scenes:normalize（classify-scene-ratings --write && optimize-scenes --write && validate-scenes）', unknown: [], notes: ['末段 validate-scenes 只读；分级脚本只维护分级元数据不改写 negative；定稿保护拦截受保护字段'] },
  },
  'legacy:tags:split': {
    desc: '旧格式标签聚合拆分；已迁移项目在内容维护中编辑标签',
    cmd: ['node', 'scripts/maintenance/split-tags.js', '--write'], docs: 'docs/maintenance.md#迁移与保护',
    run: { nature: ['writes-source', 'guard'], machine: ['node'], switches: {}, resume: 'idempotent', evidence: 'scripts/lib/tag-store.ts writeTagShards', unknown: [] },
  },
  'legacy:tags:import': {
    desc: '旧格式标签聚合拆分后重建；已迁移项目拒绝回写',
    cmd: ['npm', 'run', 'legacy:tags:import'], docs: 'docs/maintenance.md#迁移与保护',
    run: { nature: ['writes-source', 'writes-product', 'guard'], machine: ['node'], switches: {}, resume: 'idempotent', evidence: 'package.json scripts.legacy:tags:import', unknown: [] },
  },
};
