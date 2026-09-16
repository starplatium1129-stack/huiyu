#!/usr/bin/env node
'use strict';

/**
 * AI-CG-Studio 热门角色全流程自动化接入与资产流水线 (Character Onboarding Pipeline)
 *
 * 一站式完成新增角色全链路闭环：
 *   1. 档案与场景注册（popular-characters.json / characters.json / scene-blueprints.json）
 *   2. 参考规范同步（character-reference-standards.json / character-reference-view.json）
 *   3. 头像立绘渲染与点阵粒子场构建（assets/characters/ / assets/particles/）
 *   4. 4 视角电影级标准参考资产库生成（4 视角 × N 套服装 + 私密全裸形态）
 *   5. Showcase 官方样张渲染与大盘注册（SFW + 显式解剖 NSFW × @rella 统一样式）
 *   6. DATA_VERSION 自动哈希校验（由 Vite virtual:data-version 注入）
 *   7. 质量门禁验证与桌面端一键增量部署
 *
 * 用法:
 *   node scripts/maintenance/workflow-onboard-popular-character.js --character <id> [--skip-render] [--deploy]
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { execSync }: typeof import('child_process') = require('child_process');
const { expectedDataVersion }: typeof import('../lib/data-version') = require('../lib/data-version');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const POPULAR_FILE = path.join(DATA_DIR, 'popular-characters.json');
const BLUEPRINTS_FILE = path.join(DATA_DIR, 'scene-blueprints.json');
const STANDARDS_FILE = path.join(DATA_DIR, 'character-reference-standards.json');
// 2026-08-29：参考图迁出项目 → AI 工作区 CharacterReferences；找不到退回项目 assets。
const refRoot = (() => {
  const ws = process.env.AI_WORKSPACE_ROOT || path.resolve(ROOT, '..', 'AI');
  const candidate = path.join(ws, 'CharacterReferences');
  return fs.existsSync(candidate) ? candidate : path.join(ROOT, 'assets', 'character-references');
})();
// 样张目录不再写死版本号（2026-08-30 教训：写死 2026-08-15_v23 而应用经
// resolveSceneShowcaseDir 已读 v25，样张落错目录导致「效果样子没有新角色」）。
// 复用网关同一份解析：含 manifest.json 的版本子目录按名倒序取最新（排除
// .building-*），SCENE_SHOWCASE_DIR 环境变量显式覆盖契约与网关一致。
const { resolveSceneShowcaseDir }: typeof import('../../server/config') = require('../../server/config');
const AI_WORKSPACE = process.env.AI_WORKSPACE_ROOT || path.resolve(ROOT, '..', 'AI');
const SHOWCASE_DIR = resolveSceneShowcaseDir(ROOT, process.env.SCENE_SHOWCASE_DIR, AI_WORKSPACE);
const MANIFEST_FILE = path.join(SHOWCASE_DIR, 'manifest.json');
// 2026-08-30：网页端（主工作区 server.js）与桌面端（resources/gateway sidecar）
// 是两套独立网关，默认均监听 3000；3123 仅是历史 sidecar/桌面更新端点，不是
// 当前网关端口。优先 AICS_COMMS_BASE 环境变量覆盖，默认回退 3000。
const COMMS_BASE = process.env.AICS_COMMS_BASE || 'http://127.0.0.1:3000';

function syncDataVersion() {
  const expected = expectedDataVersion(ROOT);
  console.log(`[Version Sync] DATA_VERSION 将由 virtual:data-version 注入: ${expected}`);
  return expected;
}

async function submitAnimaJob(payload: any) {
  const res = await fetch(`${COMMS_BASE}/api/anima/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Submit failed (${res.status}): ${txt}`);
  }
  const data = await res.json();
  return data.job.id;
}

async function pollJob(jobId: any, timeoutMs: any = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${COMMS_BASE}/api/anima/jobs/${jobId}`);
    if (res.ok) {
      const data = await res.json();
      if (data.job.status === 'succeeded' || data.job.status === 'completed') {
        const imgUrl = data.job.resultUrl || (data.job.outputs && data.job.outputs[0]);
        const fullUrl = imgUrl.startsWith('http') ? imgUrl : `${COMMS_BASE}${imgUrl}`;
        const imgRes = await fetch(fullUrl);
        return Buffer.from(await imgRes.arrayBuffer());
      }
      if (data.job.status === 'failed') {
        throw new Error(`Job failed: ${data.job.error || 'unknown error'}`);
      }
    }
    await new Promise<any>((r: any) => setTimeout(r, 1200));
  }
  throw new Error(`Polling timeout for job ${jobId}`);
}

async function renderImage({ prompt, negative, width = 832, height = 1216, steps = 28, cfg = 4.5, seed }: any) {
  const jobId = await submitAnimaJob({
    modelId: 'anima-miaomiao-v1.2',
    prompt,
    negative,
    width,
    height,
    steps,
    cfg,
    teaCache: true,
    teaCacheThresh: 0.08,
    seed
  });
  return await pollJob(jobId);
}

function convertShowcase(srcPng: any, dstBig: any, dstThumb: any) {
  const cmd = `python scripts/maintenance/convert-showcase-image.py "${srcPng}" "${dstBig}" "${dstThumb}"`;
  execSync(cmd, { cwd: ROOT, stdio: 'pipe' });
}

async function runPipeline(charId: any, opts: any = {}) {
  console.log(`\n========================================================`);
  console.log(`🚀 启动角色一站式接入流水线: ${charId}`);
  console.log(`========================================================\n`);

  const popular = require(path.join(ROOT, 'src', 'utils', 'popularContent.ts'));
  const popularChars = popular.parsePopularCharacters(JSON.parse(fs.readFileSync(POPULAR_FILE, 'utf8')));
  const blueprints = popular.parseSceneBlueprints(JSON.parse(fs.readFileSync(BLUEPRINTS_FILE, 'utf8')));

  const character = popular.findCharacter(popularChars, charId);
  if (!character) {
    throw new Error(`角色未在 popular-characters.json 中找到: ${charId}`);
  }

  const charBlueprints = blueprints.filter((b: any) => b.characterId === charId);
  console.log(`[1/6 契约检查] 角色: ${character.displayName} (${character.id})，服装: ${character.outfits.length} 套，专属蓝图: ${charBlueprints.length} 个`);

  // Step 2: 规范与 TS 契约同步
  console.log(`\n[2/6 同步多服装标准] 运行 sync-multi-outfit-standards.js...`);
  execSync(`node scripts/maintenance/sync-multi-outfit-standards.js`, { cwd: ROOT, stdio: 'inherit' });

  // Step 3: 构建点阵粒子场
  console.log(`\n[3/6 粒子场构建] 运行 build-particle-portraits.py...`);
  const avatarPath = path.join(ROOT, 'assets', 'characters', `popular-${charId}.png`);
  if (fs.existsSync(avatarPath)) {
    execSync(`python scripts/maintenance/build-particle-portraits.py ${charId}`, { cwd: ROOT, stdio: 'inherit' });
    const pFile = path.join(ROOT, 'assets', 'particles', `p_${charId}.json`);
    let pTxt = fs.readFileSync(pFile, 'utf8');
    if (!pTxt.endsWith('\n')) fs.writeFileSync(pFile, pTxt + '\n', 'utf8');
  } else {
    console.log(`  警告: 头像立绘未找到: ${avatarPath}`);
  }

  // Step 4: 渲染 4 视角参考资产库
  if (!opts.skipRender) {
    console.log(`\n[4/6 参考资产库渲染] 检查 4 视角资产...`);
    const standards = JSON.parse(fs.readFileSync(STANDARDS_FILE, 'utf8'));
    const stdChar = standards.characters.find((c: any) => c.id === charId);
    const refBaseDir = path.join(refRoot, charId);

    const PERSPECTIVE_CONFIGS: any = {
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

    if (stdChar) {
      for (const outfit of stdChar.outfits) {
        const outfitDir = path.join(refBaseDir, outfit.id);
        if (!fs.existsSync(outfitDir)) fs.mkdirSync(outfitDir, { recursive: true });
        const isNude = outfit.id === 'nsfw_nude' || outfit.isNsfw;

        let charTokens = stdChar.identityTokens ? stdChar.identityTokens.join(', ') : stdChar.id;
        if (isNude) {
          charTokens = charTokens.replace(/\b(witch_hat|cape|dress|uniform|blazer|skirt|shoes|boots|gloves|jacket|coat|hoodie|thighhighs|socks)\b/gi, '');
        }

        const outfitTokens = Array.isArray(outfit.tokens) ? outfit.tokens.join(', ') : '';
        const outfitProse = outfit.prose || '';

        for (const persId of Object.keys(PERSPECTIVE_CONFIGS)) {
          const targetPng = path.join(outfitDir, `${persId}.png`);
          if (fs.existsSync(targetPng) && fs.statSync(targetPng).size > 10000) {
            console.log(`  [已存在] ${outfit.name} (${persId})`);
            continue;
          }

          console.log(`  [渲染中] ${outfit.name} (${persId})...`);
          const pConfig = PERSPECTIVE_CONFIGS[persId];
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
            isNude ? "clothes, clothing, shirt, pants, dress, kimono, robe, towel, underwear, bra, panties, panties_pull, swimsuit, bikini, skirt, socks, footwear, shoes, fabric covering, censors, mosaic" : "",
            pConfig.negSuffix
          ].filter(Boolean);

          const imgBuf = await renderImage({
            prompt: promptParts.join(', '),
            negative: negParts.join(', '),
            width: 832,
            height: 1216,
            steps: 28,
            cfg: isNude ? 5.2 : 4.5,
            seed: 50000000 + Math.floor(Math.random() * 1000000)
          });
          fs.writeFileSync(targetPng, imgBuf);
          console.log(`  [已保存] ${targetPng}`);
        }
      }
    }
  }

  // Step 5: Showcase 样张渲染与大盘注册
  if (!opts.skipRender) {
    console.log(`\n[5/6 Showcase 样张流水线] 检查与更新官方样张...`);
    if (!SHOWCASE_DIR || !fs.existsSync(MANIFEST_FILE)) {
      throw new Error('未解析到活跃样张目录（SceneShowcase 版本子目录缺失或无 manifest.json）；请设置 SCENE_SHOWCASE_DIR 指向目标版本目录后重试');
    }
    console.log(`  活跃样张目录: ${SHOWCASE_DIR}`);
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    const tempDir = path.join(ROOT, 'assets', 'custom-gens', `pipeline-${charId}-temp`);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    for (let i = 0; i < charBlueprints.length; i++) {
      const bp = charBlueprints[i];
      const dstBig = path.join(SHOWCASE_DIR, 'images', `pc_${charId}_${bp.id}.jpg`);
      const dstThumb = path.join(SHOWCASE_DIR, 'thumbs', `pc_${charId}_${bp.id}.jpg`);

      if (fs.existsSync(dstBig) && fs.existsSync(dstThumb) && fs.statSync(dstBig).size > 10000) {
        console.log(`  [已存在样张] ${bp.title} (${bp.id})`);
        continue;
      }

      console.log(`  [渲染样张 ${i + 1}/${charBlueprints.length}] ${bp.title} (adult: ${Boolean(bp.adult)})...`);
      const plan = popular.buildPopularPromptPlan({
        character,
        outfit: character.outfits.find((o: any) => o.id === bp.outfitId) || character.outfits[0],
        blueprint: bp,
        engine: 'anima',
        adultEnabled: true,
        artist: 'rella'
      });

      let prompt = plan.prompt;
      if (!prompt.includes('@rella')) prompt = `@rella, ${prompt}`;

      const tempPng = path.join(tempDir, `pc_${charId}_${bp.id}.png`);
      const imgBuf = await renderImage({
        prompt,
        negative: plan.negative,
        width: 832,
        height: 1216,
        steps: 28,
        cfg: bp.adult ? 5.2 : 4.5,
        seed: 70000000 + i * 12345
      });
      fs.writeFileSync(tempPng, imgBuf);
      convertShowcase(tempPng, dstBig, dstThumb);

      const entryId = `pc_${charId}_${bp.id}`;
      const newEntry = {
        id: entryId,
        title: `${character.displayName} / ${bp.title}`,
        story: bp.description || '',
        category: '热门角色',
        char: character.id,
        displayName: character.displayName,
        rating: bp.adult ? 'R18' : 'All',
        attempt: 1,
        type: 'popular',
        image: `images/pc_${charId}_${bp.id}.jpg`,
        thumb: `thumbs/pc_${charId}_${bp.id}.jpg`,
        meta: {
          engine: 'anima',
          model: 'anima-aesthetic-v1.1',
          checkpoint: 'anima-aesthetic-v1.1.safetensors',
          seed: 70000000 + i * 12345
        },
        prompt,
        negative: plan.negative,
        provenance: {
          batch: 'popular',
          key: `popular:${charId}:${bp.id}`,
          recordId: `popular:${charId}:${bp.id}@attempt-1`,
          attempt: 1,
          generatedAt: new Date().toISOString(),
          review: {
            verdict: 'pass',
            recordId: `popular:${charId}:${bp.id}@attempt-1`,
            notes: '流水线自动化构建入库样张',
            reviewedAt: new Date().toISOString()
          }
        }
      };

      const existingIdx = manifest.entries.findIndex((e: any) => e.id === entryId);
      if (existingIdx >= 0) manifest.entries[existingIdx] = newEntry;
      else manifest.entries.push(newEntry);
    }

    manifest.counts = manifest.counts || {};
    manifest.counts.popular = manifest.entries.filter((e: any) => e.type === 'popular').length;
    manifest.entryCount = manifest.entries.length;
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  // Step 6: 自动版本对齐与回归验证
  console.log(`\n[6/6 版本哈希与质量门禁] 对齐 DATA_VERSION 并执行回归...`);
  syncDataVersion();

  execSync('npm run typecheck:app', { cwd: ROOT, stdio: 'inherit' });
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  execSync('node scripts/maintenance/validate-content-contracts.js', { cwd: ROOT, stdio: 'inherit' });
  execSync('node scripts/tests/test-popular-content.js', { cwd: ROOT, stdio: 'inherit' });

  if (opts.deploy) {
    console.log(`\n[桌面部署] 正在增量同步至桌面端...`);
    execSync('powershell -ExecutionPolicy Bypass -File scripts/maintenance/deploy-desktop-quick.ps1 -NoRestart', { cwd: ROOT, stdio: 'inherit' });
  }

  console.log(`\n✨ 角色 ${character.displayName} (${charId}) 全链路一站式接入完成！`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let charId = '';
  let skipRender = false;
  let deploy = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--character' || args[i] === '-c') {
      charId = args[++i];
    } else if (args[i] === '--skip-render') {
      skipRender = true;
    } else if (args[i] === '--deploy') {
      deploy = true;
    }
  }

  return { charId, skipRender, deploy };
}

async function main() {
  const { charId, skipRender, deploy } = parseArgs();
  if (!charId) {
    console.log(`用法: node scripts/maintenance/workflow-onboard-popular-character.js --character <character_id> [--skip-render] [--deploy]`);
    process.exit(1);
  }
  await runPipeline(charId, { skipRender, deploy });
}

if (require.main === module) {
  main().catch((err: any) => {
    console.error('Pipeline failed:', err);
    process.exit(1);
  });
}

export = { runPipeline, syncDataVersion };

