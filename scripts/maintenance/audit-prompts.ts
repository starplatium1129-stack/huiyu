const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const catalogSnapshot: typeof import('../lib/catalog-snapshot') = require('../lib/catalog-snapshot');

interface AuditScene { id: string; title: string; char?: string; prompt?: string }

const root = path.resolve(__dirname, '..', '..');
const records = catalogSnapshot.read(root);
const scenes: AuditScene[] = records
  ? catalogSnapshot.views(records).scenes
  : JSON.parse(fs.readFileSync(path.join(root, 'data', 'scenes.json'), 'utf8'));
const pinned = records?.find(record => record.kind === 'document' && record.id === 'prompt-pinned-scenes')?.data.scenes;
const findings: { id: string; title: string; issues: string[]; protected: boolean }[] = [];

for (const scene of scenes) {
  const prompt = String(scene.prompt || '');
  const lower = prompt.toLowerCase();
  const issues: string[] = [];
  if (/\bclose_up\b/.test(lower) && /\b(full_body|wide_shot)\b/.test(lower)) issues.push('镜头同时包含 close_up 与 full_body/wide_shot');
  if (/\bupper_body\b/.test(lower) && /\bfull_body\b/.test(lower)) issues.push('镜头同时包含 upper_body 与 full_body');
  if (scene.char === 'triad' && !/\bBREAK\b/i.test(prompt)) issues.push('双人场景缺少 BREAK 分区');
  if (issues.length) findings.push({ id: scene.id, title: scene.title, issues, protected: Boolean(pinned && Object.hasOwn(pinned, scene.id)) });
}

const protectedCount = findings.filter(finding => finding.protected).length;
console.log(`Prompt audit: ${scenes.length} scenes, ${findings.length - protectedCount} actionable findings, ${protectedCount} pinned findings`);
for (const finding of findings) {
  const status = finding.protected ? '（定稿，需实图复核后走 scenes:pin-capture）' : '';
  console.log(`${finding.id} ${finding.title}${status} - ${finding.issues.join('；')}`);
}
