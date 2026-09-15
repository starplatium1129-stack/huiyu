#!/usr/bin/env node
'use strict';

/**
 * 按参考标准生成 4 视角待审核候选；--output 必须显式指定隔离目录。
 *
 * 规范：
 * - 引擎：MiaoMiao Harem Anima v1.6（2026-09-06 由 v1.2 升级，用户指定；TeaCache 加速全开）
 * - 并发：3 并发任务池（安全稳定不爆显存）
 * - 尺寸：832 × 1216（兼顾出图速度与画面精细度）
 * - 断点：核验输入与图片哈希，恢复已知 job；明确失败才自动重试。
 * - 帮助/预览不写文件、不请求模型；候选不回填参考库、不自动审核。
 */

const safety = require('../lib/generation-candidates');

const PERSPECTIVE_CONFIGS = {
  ref_01_face_closeup: {
    suffix: "face and eyes extreme close-up portrait, 85mm f/1.4 shallow depth of field, soft bokeh, expressive anime eyes, looking at viewer, subtle gentle expression, soft cinematic studio key light, highly detailed facial features and skin texture",
    negSuffix: "full body, upper body, hands, extra limbs, blurry face, bad eyes, lowres",
  },
  ref_02_half_medium: {
    suffix: "upper body focus, medium shot, waist up, cowboy shot, 3/4 view angle, hands visible resting naturally near waist, detailed outfit layers, fabric folds, cinematic soft studio lighting",
    negSuffix: "full body, legs, feet, shoes, boots, bad anatomy, bad hands, extra limbs, cropped shoulders, blurry",
  },
  ref_03_full_dynamic: {
    suffix: "full body standing, entire figure visible from head to toe, front view, facing camera, looking at viewer, complete head, entire legs, full feet and shoes completely on the ground without cropping, clean studio floor shadow, balanced standing posture, full outfit details",
    negSuffix: "back view, from behind, rear view, cropped head, cropped feet, cut off feet, out of frame, bad proportions, distorted legs",
  },
  ref_04_back_rear: {
    suffix: "45 degree angle from behind, looking back over shoulder toward camera, back view focus, back of hair, hair flow, rear outfit details, cinematic rim lighting, dramatic backlight, edge glow",
    negSuffix: "front view, facing camera, frontal face, bad anatomy, lowres",
  }
};

function buildPrompt(char, outfit, persId) {
  const pConfig = PERSPECTIVE_CONFIGS[persId];
  const isNude = outfit.id === 'nsfw_nude' || outfit.name.includes('全裸') || outfit.name.includes('纯粹');

  let charTokens = Array.isArray(char.identityTokens) ? char.identityTokens.join(', ') : char.id;
  // 如果是全裸形态，剥离角色特征里可能自带的衣物 token
  if (isNude) {
    charTokens = charTokens.replace(/\b(witch_hat|cape|dress|uniform|blazer|skirt|shoes|boots|gloves|jacket|coat|hoodie|thighhighs|socks)\b/gi, '');
  }

  const outfitTokens = Array.isArray(outfit.tokens) && outfit.tokens.length > 0 ? outfit.tokens.join(', ') : '';
  const outfitProse = outfit.prose || '';

  const promptParts = [
    isNude ? "nude, completely naked, uncensored, full body bare, natural skin" : "",
    charTokens,
    outfitTokens,
    outfitProse,
    pConfig.suffix,
    "@rella, masterpiece, best quality, pristine anime aesthetic, clean cinematic lighting"
  ].filter(Boolean);

  const negParts = [
    "bad anatomy, bad hands, extra limbs, extra arms, extra legs, poorly drawn face, poorly drawn hands, missing fingers, extra digits, cropped, split image, split screen, multiple views, comic panel, collaged, sketch, lowres, blurry, jpeg artifacts, watermark, signature",
    isNude ? "clothes, clothing, shirt, pants, dress, kimono, robe, towel, underwear, bra, panties, panties_pull, swimsuit, bikini, skirt, socks, footwear, shoes, fabric covering" : "",
    pConfig.negSuffix
  ].filter(Boolean);

  return {
    prompt: promptParts.join(', '),
    negative: negParts.join(', ')
  };
}

// 收集所有待渲染任务
function collectTasks(standards, opts) {
  const tasks = [];
  const only = opts.ids ? new Set(opts.ids.split(',').map(s => s.trim()).filter(Boolean)) : null;
  for (const char of standards.characters) {
    if (only && !only.has(char.id)) continue;
    for (const outfit of char.outfits) {
      for (const pers of standards.perspectives) {
        // 设计图三视图（ref_design_*）归 reference:design / render-design-sheets.js 专管：
        // 本脚本无其构图配置，混入只会逐任务三次空转失败（2026-09-06 修正）。
        if (!PERSPECTIVE_CONFIGS[pers.id]) continue;
        tasks.push({
          key: `reference:${char.id}:${outfit.id}:${pers.id}`,
          metadata: { batch: 'reference', engine: 'anima', characterId: char.id,
            charName: char.displayName, outfitId: outfit.id, outfitName: outfit.name,
            persId: pers.id, persName: pers.name,
            intendedReferencePath: `${char.id}/${outfit.id}/${pers.id}.png` },
          payload: () => buildPayload(char, outfit, pers.id, Math.floor(Math.random() * 1000000000) + 100000000)
        });
      }
    }
  }
  return tasks;
}

function buildPayload(char, outfit, persId, seed) {
  const { prompt, negative } = buildPrompt(char, outfit, persId);
  return {
    modelId: 'anima-miaomiao-v1.6',
    prompt,
    negative,
    width: 832,
    height: 1216,
    steps: 28,
    cfg: 4.5,
    teaCache: true,
    teaCacheThresh: 0.08,
    seed
  };
}

async function main(args = process.argv.slice(2), deps = {}) {
  const opts = safety.parseArgs(args, { ids: 'value' }, deps.env || process.env);
  if (opts.help) return safety.help(__filename, '[--ids=a,b,c]');
  const input = safety.snapshot(opts.root, ['data/character-reference-standards.json']);
  const tasks = collectTasks(input.data['data/character-reference-standards.json'], opts);
  return safety.runCandidates({ opts, script: __filename, tasks, sources: input.sources, maxAttempts: 5 }, deps);
}

module.exports = { main, buildPrompt, buildPayload, collectTasks };
if (require.main === module) safety.runCli(main);
