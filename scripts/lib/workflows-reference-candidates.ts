'use strict';
import type { RegisteredWorkflows } from './workflow-types';

const docs = 'docs/workflow.md#参考库候选审核与版本发布';
const command = (action: string) => ['node', 'scripts/maintenance/reference-candidate-workflow.js', action];
const evidence = 'scripts/maintenance/reference-candidate-workflow.js:1';
const referenceCandidateWorkflows: RegisteredWorkflows = {
  'reference:inspect': {
    desc: '只读核对候选字节、源版本及记录；不代表图像审核', cmd: command('inspect'), docs,
    required: ['--from'], opts: '--from <reference-generation-manifest.json> [--root <项目根>]',
    run: { nature: ['read-only', 'guard'], machine: ['node'], switches: {}, resume: 'na', evidence,
      unknown: ['结构与字节通过不能替代人工画面审核'] },
  },
  'reference:review': {
    desc: '记录明确人工决定，绑定候选记录、图片哈希及源版本', cmd: command('review'), docs,
    required: ['--from', '--decisions', '--out'],
    opts: '--from <候选清单> --decisions <候选目录/decisions.json> --out <候选目录/manual-review.json> [--root <项目根>]',
    run: { nature: ['writes-product', 'guard'], machine: ['node'], switches: {}, resume: 'na', evidence,
      unknown: ['记录人工输入，不认证审核者实际看过图片'], notes: ['仅新建审核文件，缺少决定保持pending；重试或源变化使旧决定失效'] },
  },
  'reference:publish': {
    desc: '预览参考候选版本发布；显式apply创建完整不可变新版本', cmd: command('publish'), docs,
    required: ['--from', '--review', '--source', '--target'],
    opts: '--from <候选清单> --review <人工审核JSON> --source <现有参考库目录> --target <新版本目录> [--root <项目根>] [--apply]',
    run: { nature: ['read-only', 'preview', 'guard'], machine: ['node'], switches: { '--apply': ['writes-release', 'writes-product', 'delete'] },
      resume: 'checkpoint', evidence, unknown: ['真实资产质量及主力机激活仍需对应环境验收'],
      notes: ['所有候选须有当前版本人工通过决定；旧库/项目源索引不变；仅删除自有锁，失败暂存保留；显式配置参考库根并重启激活，保留旧根回滚'] },
  },
  'reference:retry': {
    desc: '对指定参考候选重新生成，使用原配方并保持待人工审核',
    cmd: ['node', 'scripts/maintenance/render-all-outfits-references.js', '--force'], docs,
    required: ['--output', '--keys'], opts: '--output <候选目录> --keys <reference:角色:服装:机位,...> [--root <项目根>] [--gateway <url>] [--dry-run]',
    run: { nature: ['external-model', 'writes-product'], machine: ['gateway', 'node'], switches: { '--dry-run': ['preview'] },
      resume: 'checkpoint', evidence: 'scripts/maintenance/render-all-outfits-references.js:1',
      unknown: ['真实生成与人工画面审核待主力机执行'], notes: ['不继承旧记录审核，不改配方或活跃库'] },
  },
  'reference:full': {
    desc: '参考候选生成/续跑→完整性核对→明确人工决定→发布预览', cmd: command('full'), docs,
    required: ['--output', '--source', '--target'],
    opts: '--output <候选目录> --source <现有参考库目录> --target <新版本目录> [--root <项目根>] [--ids <角色>] [--keys <候选key>] [--gateway <url>] [--review <审核JSON> | --decisions <决定JSON> --out <新审核JSON>] [--dry-run]',
    run: { nature: ['external-model', 'writes-product'], machine: ['gateway', 'node'], switches: { '--dry-run': ['preview'], '--retry-unknown': ['external-model', 'writes-product'] },
      resume: 'checkpoint', evidence, unknown: ['缺少人工决定返回3并保持待验；真实模型/画面/设备未由模拟证明'],
      notes: ['不再调用旧活跃库audit/repair；只预览发布，实际写新版本走reference:publish --apply；dry-run零写入/零模型'] },
  },
};

export = { referenceCandidateWorkflows };
