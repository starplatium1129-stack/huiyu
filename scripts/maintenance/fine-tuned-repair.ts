#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

/**
 * 针对 98 张顽固未通过项的「精细化提示词微调修复产线」
 * 
 * 核心对症下药策略：
 * 1. 【面部特写 ref_01_face_closeup】（63张）：
 *    - 核心痛点：模型容易画成俯视半身或带胸部躯干
 *    - 调优词：tight headshot portrait, extreme close-up on face, chin to forehead framing, 85mm macro lens, face focus, eye level straight-on
 *    - 负向压制：torso, body, arms, hands, legs, waist, outfit, dress, cleavage, wide shot, distant, high angle, bird's eye view
 * 
 * 2. 【3/4半身定妆 ref_02_half_medium】（27张）：
 *    - 核心痛点：模型容易画成完全正面立姿
 *    - 调优词：medium cowboy shot, waist up, angled body, 3/4 turn angle, torso turned 45 degrees from camera, side-ish angle
 *    - 负向压制：straight front view, facing camera squarely, full body, feet, shoes, close-up face only
 * 
 * 3. 【正面全身 ref_03_full_dynamic】（6张）：
 *    - 调优词：full body shot from head to toe, entire standing figure, feet and shoes completely on floor, standing straight
 *    - 负向压制：cropped feet, cut off feet, out of frame, knees up, waist up, sitting
 * 
 * 4. 【45°侧后背影 ref_04_back_rear】（2张）：
 *    - 调优词：view from behind, back view focus, 45 degree angle rear shot, turned away from camera, back of shoulders and hair
 *    - 负向压制：front view, frontal chest, facing camera
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { execFile }: typeof import('child_process') = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const STANDARDS_FILE = path.join(ROOT, 'data', 'character-reference-standards.json');
const REPORT_FILE = path.join(ROOT, 'runtime', 'multi-outfit-audit-report.json');
const OUT_BASE = path.join(ROOT, 'assets', 'character-references');
const BASE = 'http://127.0.0.1:3000';

const standards = JSON.parse(fs.readFileSync(STANDARDS_FILE, 'utf8'));
let auditReport = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));

function saveReport() {
  fs.writeFileSync(REPORT_FILE, JSON.stringify(auditReport, null, 2), 'utf8');
}

const TAILORED_PERSPECTIVE_PROMPTS: any = {
  ref_01_face_closeup: {
    guide: "此图是否为标准的角色【面部与微表情特写】（头部或脸部特写，平视，85mm浅景深）？画面中是否单人、五官清晰、无崩坏、无双人或分身、无漫画分格？",
    suffix: "tight headshot portrait, extreme close-up on face, chin to forehead framing, 85mm macro lens, face focus, eye level straight-on, expressive detailed eyes, soft cinematic portrait lighting",
    negative: "torso, body, arms, hands, legs, waist, skirt, cleavage, wide shot, distant, high angle, bird's eye view, foreshortening, full body, cowboy shot, medium shot"
  },
  ref_02_half_medium: {
    guide: "此图是否为标准的角色【3/4侧身半身定妆中景】（腰部至胸部服饰，身体微侧）？画面中是否单人、双手与服装层次清晰、无崩坏、无双人或分身？",
    suffix: "medium cowboy shot, waist up, angled body, 3/4 turn angle, torso turned 45 degrees from camera, hands resting naturally, detailed outfit layers, clean studio lighting",
    negative: "straight front view, facing camera squarely, full body, lower legs, feet, shoes, boots, extreme closeup, face only, cropped shoulders"
  },
  ref_03_full_dynamic: {
    guide: "此图是否为标准的角色【正面全身立姿】（从头顶到双脚鞋履完整可见、无截断）？画面中是否单人、正面朝向镜头、无双人分身、无背面？",
    suffix: "full body shot from head to toe, entire figure visible, front view, standing straight on ground, shoes completely visible without cut-off, balanced standing posture",
    negative: "cropped feet, cut off feet, cropped head, knees up, waist up, sitting, out of frame, rear view, back view"
  },
  ref_04_back_rear: {
    guide: "此图是否为标准的角色【45°侧后背影 / 回眸】（展现后背服饰或发型流向）？画面中是否单人、轮廓光清晰、无崩坏？",
    suffix: "view from behind, back view focus, 45 degree angle rear shot, turned away from camera, looking back over shoulder, back of hair and back details, dramatic backlight, rim lighting",
    negative: "front view, frontal chest, facing camera directly, front facing"
  }
};

function runVisionInspect(imagePath: any, promptGuide: any) {
  return new Promise<any>((resolve: any) => {
    const inspectScript = path.join(ROOT, 'scripts', 'maintenance', 'image-inspect.js');
    const promptText = `${promptGuide}\n\n请按以下格式回答：\n【审核结论】：通过 / 不通过\n【详细理由】：...`;
    
    execFile('node', [inspectScript, imagePath, '-p', promptText], { timeout: 60000 }, (error: any, stdout: any, stderr: any) => {
      const output = (stdout || '') + (stderr || '');
      let passed = false;
      const conclusionMatch = output.match(/【审核结论】[：:]\s*(通过|不通过)/);
      if (conclusionMatch) {
        passed = (conclusionMatch[1] === '通过');
      } else if (output.includes('不通过')) {
        passed = false;
      } else if (output.includes('通过')) {
        passed = true;
      }

      if (passed && /(分身|双人|复制体|多格|分镜拼贴|并排两人)/.test(output) && !/(无分身|无双人|非双人|非分身)/.test(output)) {
        passed = false;
      }

      resolve({ passed, reason: output.trim() });
    });
  });
}

function buildFineTunedPrompt(char: any, outfit: any, persId: any) {
  const pConfig = TAILORED_PERSPECTIVE_PROMPTS[persId];
  const isNude = outfit.id === 'nsfw_nude' || outfit.name.includes('全裸') || outfit.name.includes('纯粹');

  let charTokens = Array.isArray(char.identityTokens) ? char.identityTokens.join(', ') : char.id;
  if (isNude) {
    charTokens = charTokens.replace(/\b(witch_hat|cape|dress|uniform|blazer|skirt|shoes|boots|gloves|jacket|coat|hoodie|thighhighs|socks)\b/gi, '');
  }

  // 若为特写，则在提示词中完全去除大件裙摆与鞋袜词，防止模型联想全身
  let outfitTokens = Array.isArray(outfit.tokens) ? outfit.tokens.join(', ') : '';
  if (persId === 'ref_01_face_closeup') {
    outfitTokens = outfitTokens.replace(/\b(boots|shoes|socks|thighhighs|skirt|pants|long_dress|legs)\b/gi, '');
  }

  const promptParts = [
    isNude ? "nude, completely naked, uncensored, full body bare, natural skin" : "",
    charTokens,
    outfitTokens,
    pConfig.suffix,
    "@rella, masterpiece, best quality, anime aesthetic, clean composition"
  ].filter(Boolean);

  const negParts = [
    "bad anatomy, bad hands, extra limbs, extra arms, extra legs, poorly drawn face, poorly drawn hands, missing fingers, extra digits, cropped, split image, split screen, multiple views, comic panel, collaged, sketch, lowres, blurry, jpeg artifacts, watermark, signature",
    isNude ? "clothes, clothing, shirt, pants, dress, kimono, robe, towel, underwear, bra, panties, swimsuit, bikini, skirt, socks, footwear, shoes, fabric covering" : "",
    pConfig.negative
  ].filter(Boolean);

  return {
    prompt: promptParts.join(', '),
    negative: negParts.join(', ')
  };
}

async function renderImage(char: any, outfit: any, persId: any, targetPath: any) {
  const { prompt, negative } = buildFineTunedPrompt(char, outfit, persId);
  const payload: any = {
    modelId: 'anima-miaomiao-v1.2',
    prompt,
    negative,
    width: 832,
    height: 1216,
    steps: 28,
    cfg: 4.5,
    teaCache: true,
    teaCacheThresh: 0.08,
    seed: Math.floor(Math.random() * 1000000000) + 100000000
  };

  // 如果是主角宁宁或夏目，附带专属 v21 LoRA
  if (char.id === 'nene') {
    payload.character = 'nene';
    payload.loraId = 'L_NENE_V21_ANIMA';
    payload.loraStrength = 0.85;
  } else if (char.id === 'natsume') {
    payload.character = 'natsume';
    payload.loraId = 'L_NAT_V21_ANIMA';
    payload.loraStrength = 0.85;
  }

  const submitRes = await fetch(`${BASE}/api/anima/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const submitJson = await submitRes.json();
  if (!submitRes.ok || !submitJson.ok || !submitJson.job?.id) {
    throw new Error(`提交重绘失败: ${JSON.stringify(submitJson)}`);
  }

  const jobId = submitJson.job.id;
  const deadline = Date.now() + 10 * 60 * 1000;
  let jobState = null;

  while (Date.now() < deadline) {
    await new Promise<any>((r: any) => setTimeout(r, 2000));
    const queryRes = await fetch(`${BASE}/api/anima/jobs/${encodeURIComponent(jobId)}`);
    const queryJson = await queryRes.json();
    if (queryRes.ok && queryJson.ok && queryJson.job) {
      jobState = queryJson.job;
      if (jobState.status === 'succeeded' && jobState.resultUrl) break;
      if (jobState.status === 'failed' || jobState.status === 'cancelled') {
        throw new Error(`重绘失败: ${jobState.error || jobState.status}`);
      }
    }
  }

  const imgRes = await fetch(`${BASE}${jobState.resultUrl}`);
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  fs.writeFileSync(targetPath, buffer);
}

async function runFineTunedRepair() {
  const validKeys: any[] = [];
  standards.characters.forEach((c: any) => {
    c.outfits.forEach((o: any) => {
      standards.perspectives.forEach((p: any) => {
        validKeys.push(c.id + '/' + o.id + '/' + p.id);
      });
    });
  });

  const pendingFailedKeys = validKeys.filter((k: any) => auditReport[k] && !auditReport[k].passed);
  console.log(`================================================`);
  console.log(`[Fine-Tuned Repair Engine] 启动 98 张顽固未通过项定向微调修复`);
  console.log(`待修复总数: ${pendingFailedKeys.length} 张`);
  console.log(`================================================\n`);

  let fixedCount = 0;
  for (let i = 0; i < pendingFailedKeys.length; i++) {
    const key = pendingFailedKeys[i];
    const [charId, outfitId, persId] = key.split('/');
    const char = standards.characters.find((c: any) => c.id === charId);
    if (!char) continue;
    const outfit = char.outfits.find((o: any) => o.id === outfitId);
    if (!outfit) continue;
    const targetPath = path.join(OUT_BASE, charId, outfitId, `${persId}.png`);
    const pConfig = TAILORED_PERSPECTIVE_PROMPTS[persId];

    console.log(`\n[Repair ${i + 1}/${pendingFailedKeys.length}] 正在定向微调重绘: [${char.displayName}] - [${outfit.name}] - [${persId}]...`);
    
    let pass = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await renderImage(char, outfit, persId, targetPath);
        const res = await runVisionInspect(targetPath, pConfig.guide);
        if (res.passed) {
          console.log(`  🎉 第 ${attempt} 次微调复审判定通过！(PASS)`);
          auditReport[key] = { passed: true, fineTuned: true, retries: attempt, verifiedAt: new Date().toISOString() };
          saveReport();
          fixedCount++;
          pass = true;
          break;
        } else {
          console.log(`  ⚠️ 第 ${attempt} 次复审判定不通过 (${res.reason.slice(0, 80).replace(/\n/g, ' ')}...)，换 seed 重绘...`);
        }
      } catch (err) {
        console.warn(`  ⚠️ 异常: ${runtimeErrorMessage(err)}`);
        await new Promise<any>((r: any) => setTimeout(r, 3000));
      }
    }

    if (!pass) {
      console.warn(`  ❌ 3 次微调尝试后暂未达成，保留记录`);
    }
  }

  console.log(`\n🎉 [Fine-Tuned Repair Engine] 微调修复全部结束！成功转绿灯: ${fixedCount}/${pendingFailedKeys.length}`);
}

runFineTunedRepair().catch(console.error);
