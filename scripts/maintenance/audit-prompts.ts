const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const scenesPath = path.resolve(__dirname, '..', '..', 'data', 'scenes.json');
const scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf8'));
const findings: any[] = [];

for (const scene of scenes) {
  const prompt = String(scene.prompt || '');
  const lower = prompt.toLowerCase();
  const issues: any[] = [];
  if (/\bclose_up\b/.test(lower) && /\b(full_body|wide_shot)\b/.test(lower)) issues.push('镜头同时包含 close_up 与 full_body/wide_shot');
  if (/\bupper_body\b/.test(lower) && /\bfull_body\b/.test(lower)) issues.push('镜头同时包含 upper_body 与 full_body');
  if (scene.char === 'triad' && !/\bBREAK\b/i.test(prompt)) issues.push('双人场景缺少 BREAK 分区');
  if (issues.length) findings.push({ id: scene.id, title: scene.title, issues });
}

console.log(`Prompt audit: ${scenes.length} scenes, ${findings.length} actionable findings`);
for (const finding of findings) console.log(`${finding.id} ${finding.title}: ${finding.issues.join('；')}`);
