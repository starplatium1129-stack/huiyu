'use strict';

module.exports = {
  'check:impact': {
    desc: '基于本地历史实际执行增量/完整结构核验；未覆盖域保留full要求',
    cmd: ['node', 'scripts/maintenance/check-content-impact.js'], docs: 'docs/workflow.md',
    opts: '--base <本地commit/ref> 或 --full；--execute；--root <目录>；--json；基线可组合character/outfit/scene/path',
    run: { nature: ['preview', 'read-only'], machine: ['node'],
      switches: { '--execute': ['read-only', 'guard'], '--full': ['read-only'], '--json': ['read-only'] },
      resume: 'na', evidence: 'scripts/maintenance/check-content-impact.js:1',
      unknown: ['不是完整内容gate；DATA_VERSION、压缩及未导出语义规则仍要求full'],
      notes: ['--base需本地Git，不查询远端；默认预览；执行后的局部通过仍返回3表示完整门禁未运行'] },
  },
  'audit:content-evidence': {
    desc: '只读核对候选记录、输入、人工决定、资产及显式发布字节证据',
    cmd: ['node', 'scripts/maintenance/audit-content-evidence.js'], docs: 'docs/workflow.md', required: ['--manifest'],
    opts: '--manifest <候选根相对JSON>；--root <源根>；--candidate-root <候选根>；--source <源根相对路径>（可重复）；--recipe <源根相对路径>；--decisions <候选根相对JSON>；--publication <候选根相对JSON>；--published-root <目录>；--expect-manifest-sha256 <SHA256>；--json',
    run: { nature: ['read-only', 'guard'], machine: ['node'],
      switches: { '--json': ['read-only'], '--source': ['read-only'], '--decisions': ['read-only'], '--publication': ['read-only'] },
      resume: 'na', evidence: 'scripts/maintenance/audit-content-evidence.js:1',
      unknown: ['图像质量、审核者真实性未认证；不执行发布或激活；未知generator/release适配器保持unknown'] },
  },
};
