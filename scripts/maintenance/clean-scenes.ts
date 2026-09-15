/**
 * 绫季绘境 — 场景数据批量清洗脚本
 * 修复：标签重复、格式错误、角色 DNA 缺失、tags-prompt 断层、Active Sync 占位符缺失
 * 用法：node scripts/maintenance/clean-scenes.js --write
 */
const { loadSceneShards, writeSceneSet }: typeof import('../lib/scene-store') = require('../lib/scene-store');
const write = process.argv.includes('--write');

// ── 配置 ──
const CHARACTER_DNA = {
  nene:   ['hair_ribbon'],
  natsume:['mole_under_eye'],
  triad:  ['2girls', 'mole_under_eye', 'hair_ribbon']
};

const TAG_MAP = {
  'naki-bokuro': 'mole_under_eye',
  'naki_bokuro': 'mole_under_eye',
  'close-up': 'close_up'
};

const BLACKLIST = new Set([
  // 非可视化概念
  'strawberry_chamomile_scent', 'scent', 'flavor', 'fragrance',
  'heart_rate_sync', 'infinite_loop', 'triad_bond',
  'high_cold_persona', 'sensory_sync',
  // 美术风格红线 — 来自 art-direction.html 禁用词（源头净化）
  'neon', 'glowing', 'oversaturated', 'vivid_colors', 'vivid', 'rainbow',
  'high_contrast', 'harsh_lighting', 'extremely_detailed', 'ultra_detailed',
  '8k', 'photorealistic', 'realistic_skin'
]);

// 不应出现在 tags 中的 token（角色触发词、数量前缀、权重语法、占位符）
const TAG_EXCLUDE = new Set([
  '1girl', '2girls', '3girls',
  'ayachi_nene', 'shiki_natsume',
  'masterpiece', 'best_quality',
  'extreme_detail', 'extremely_detailed', 'ultra_detailed',
  'soft_lighting'  // prompt 专用修饰词
]);

const PLACEHOLDER_PATTERN = /\{(?:intimacy_intensity|interaction_target|sensory_feedback)\}/g;

// ── 辅助函数 ──
function normalize(t) {
  return t.toLowerCase().replace(/[\s-]+/g, '_').trim();
}

function isVisualTag(t) {
  // 排除带权重语法 (xxx:1.2)、纯数字、太短的
  if (t.includes(':') || t.includes('(')) return false;
  if (/^\d+$/.test(t)) return false;
  if (t.length < 2) return false;
  return true;
}

function extractPromptTokens(prompt) {
  // 从 prompt 字符串中提取标准 snake_case token
  return prompt.split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .map(t => {
      // 去掉权重语法 (token:1.2) → token
      const m = t.match(/^\(?([^:)]+)/);
      return m ? m[1].trim() : t;
    })
    .map(normalize)
    .filter(t => isVisualTag(t) && !TAG_EXCLUDE.has(t) && !BLACKLIST.has(t) && !t.includes('{'));
}

function normalizePromptToken(token) {
  const breakMarker = 'AICSBREAKTOKEN';
  token = token.replace(/_BREAK_/gi, breakMarker).replace(/\s+BREAK\s+/gi, breakMarker);
  // 将空格分隔的 multi-word token 转为 snake_case，保留权重语法
  const weightMatch = token.match(/^(\(+)?(.+?)(:[\d.]+)?(\)+)?$/);
  if (!weightMatch) return token.replace(/\s+/g, '_').replace(new RegExp(breakMarker, 'g'), ' BREAK ');
  const [, pre, core, weight, post] = weightMatch;
  let normalized = core.replace(/[\s-]+/g, '_');
  // 应用标签映射到 prompt token
  if (TAG_MAP[normalized]) normalized = TAG_MAP[normalized];
  return ((pre || '') + normalized + (weight || '') + (post || '')).replace(new RegExp(breakMarker, 'g'), ' BREAK ');
}

// ── 主逻辑 ──
const raw = loadSceneShards().scenes;

let stats = { dedup: 0, dna: 0, mapped: 0, blacklisted: 0, commaSplit: 0, tagSync: 0, promptNorm: 0, placeholders: 0 };

const cleaned = raw.map(scene => {
  let tags = (scene.tags || []).slice();

  // 1. 拆分逗号分隔的多标签
  const expanded = [];
  tags.forEach(t => {
    if (!t) return;
    if (t.includes(',')) {
      stats.commaSplit++;
      t.split(',').map(s => s.trim()).filter(Boolean).forEach(s => expanded.push(s));
    } else {
      expanded.push(t);
    }
  });
  tags = expanded;

  // 2. 标准化 + 映射 + 黑名单
  tags = tags.map(t => {
    const norm = normalize(t);
    if (TAG_MAP[norm]) { stats.mapped++; return TAG_MAP[norm]; }
    return norm;
  });
  const beforeBL = tags.length;
  tags = tags.filter(t => !BLACKLIST.has(t));
  stats.blacklisted += beforeBL - tags.length;

  // 3. 去重
  const beforeDedup = tags.length;
  tags = [...new Set(tags)];
  stats.dedup += beforeDedup - tags.length;

  // 4. 注入角色 DNA
  const charKey = (scene.char || '').toLowerCase();
  const dna = CHARACTER_DNA[charKey] || [];
  dna.forEach(d => {
    if (!tags.includes(d)) { tags.unshift(d); stats.dna++; }
  });

  // 5. 标准化 prompt 中的 multi-word token
  let prompt = scene.prompt || '';
  if (prompt) {
    prompt = prompt.replace(/_BREAK_/gi, ' BREAK ');
    const tokens = prompt.split(',').map(t => t.trim()).filter(Boolean);
    const normalized = tokens.map(normalizePromptToken);
    const newPrompt = normalized.join(', ');
    if (newPrompt !== prompt) { stats.promptNorm++; prompt = newPrompt; }
  }

  // 6. 从已标准化的 prompt 同步缺失标签到 tags
  if (prompt) {
    const promptTokens = extractPromptTokens(prompt);
    promptTokens.forEach(t => {
      if (!tags.includes(t)) { tags.push(t); stats.tagSync++; }
    });
  }

  // 7. 移除历史动态占位符；运行时状态不应污染可发布 Prompt
  if (PLACEHOLDER_PATTERN.test(prompt)) {
    prompt = prompt.replace(PLACEHOLDER_PATTERN, '').replace(/,\s*,/g, ',').replace(/,\s*$/, '').trim();
    stats.placeholders++;
  }

  // 8. 统一负向提示词
  let negative = 'worst quality, low quality, normal quality, lowres, blurry, jpeg artifacts, text, watermark, logo, signature, bad anatomy, bad hands, extra fingers, missing fingers, fused fingers, extra arms, extra legs, deformed, bad proportions, duplicate, cropped, 3d render, photorealistic';
  if (!scene.mature) negative += ', nsfw, nude, explicit';

  return { ...scene, tags, prompt, negative };
});

if (write) writeSceneSet(cleaned);

console.log('\n=== 清洗完成 ===');
console.log('标签去重:      ', stats.dedup, '处');
console.log('逗号拆分:      ', stats.commaSplit, '处');
console.log('标签映射:      ', stats.mapped, '处 (naki-bokuro → mole_under_eye)');
console.log('黑名单清除:    ', stats.blacklisted, '处');
console.log('角色 DNA 注入: ', stats.dna, '处');
console.log('tags-prompt 同步:', stats.tagSync, '处');
console.log('prompt 标准化: ', stats.promptNorm, '处');
console.log('占位符移除:    ', stats.placeholders, '处');
console.log(write ? '\n场景分片与聚合文件已更新。' : '\n当前仅预览；添加 --write 后才会更新场景数据。');
