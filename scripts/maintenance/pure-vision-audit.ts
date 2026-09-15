#!/usr/bin/env node
'use strict';

import { PathLike } from 'node:fs';

/**
 * 纯并行视觉审核器（Pure Vision Auditor）：
 * - 专注于对 CharacterReferences（AI 工作区，2026-08-29 迁出项目）下已落盘的所有图片进行快速 4 并发审核
 * - 遇到不通过项：记录进 runtime/multi-outfit-audit-report.json，不阻塞其他图的审核
 * - 避免与正在出图的 pwsh-9 争抢 Anima 队列
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { execFile }: typeof import('child_process') = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const STANDARDS_FILE = path.join(ROOT, 'data', 'character-reference-standards.json');
const REPORT_FILE = path.join(ROOT, 'runtime', 'multi-outfit-audit-report.json');
// 2026-08-29：参考图迁出项目 → AI 工作区 CharacterReferences；找不到退回项目 assets。
const OUT_BASE = (() => {
  const ws = process.env.AI_WORKSPACE_ROOT || path.resolve(ROOT, '..', 'AI');
  const candidate = path.join(ws, 'CharacterReferences');
  return fs.existsSync(candidate) ? candidate : path.join(ROOT, 'assets', 'character-references');
})();
const AUDIT_CONCURRENCY = 4;

const standards = JSON.parse(fs.readFileSync(STANDARDS_FILE, 'utf8'));

let auditReport: Record<string, any> = {};
if (fs.existsSync(REPORT_FILE)) {
  try {
    auditReport = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
  } catch (e) {
    auditReport = {};
  }
}

function saveReport() {
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  // 合并磁盘最新报告（防多进程并发覆盖）+ 原子写入
  try {
    if (fs.existsSync(REPORT_FILE)) {
      const disk = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
      auditReport = Object.assign({}, disk, auditReport);
    }
  } catch (_) {}
  const tmp = REPORT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(auditReport, null, 2), 'utf8');
  fs.renameSync(tmp, REPORT_FILE);
}

const PERSPECTIVE_CONFIGS: any = {
  ref_01_face_closeup: {
    promptGuide: "此图是否为标准的角色【面部与微表情特写】（胸部以上或头部特写，85mm浅景深）？画面中是否单人、五官清晰、无崩坏、无双人或分身、无漫画分格？"
  },
  ref_02_half_medium: {
    promptGuide: "此图是否为标准的角色【3/4侧身半身定妆中景】（腰部至胸部服饰）？画面中是否单人、双手与服装层次清晰、无崩坏、无双人或分身？"
  },
  ref_03_full_dynamic: {
    promptGuide: "此图是否为标准的角色【正面全身立姿】（从头顶到双脚鞋履完整可见、无截断）？画面中是否单人、正面朝向镜头、无双人分身、无背面？"
  },
  ref_04_back_rear: {
    promptGuide: "此图是否为标准的角色【45°侧后背影 / 回眸】（展现后背服饰或发型流向）？画面中是否单人、轮廓光清晰、无崩坏？"
  }
};

function runVisionInspect(imagePath: string, promptGuide: unknown) {
  return new Promise<any>((resolve: any) => {
    const inspectScript = path.join(ROOT, 'scripts', 'maintenance', 'image-inspect.js');
    const promptText = `${promptGuide}\n\n请按以下格式回答：\n【审核结论】：通过 / 不通过\n【详细理由】：...`;
    
    execFile('node', [inspectScript, imagePath, '-p', promptText], { timeout: 60000 }, (error: any, stdout: any, stderr: any) => {
      const output = (stdout || '') + (stderr || '');
      let passed = false;
      let reason = output.trim();
      
      const conclusionMatch = output.match(/【审核结论】[：:]\s*(通过|不通过)/);
      if (conclusionMatch) {
        passed = (conclusionMatch[1] === '通过');
      } else if (output.includes('不通过')) {
        passed = false;
      } else if (output.includes('通过')) {
        passed = true;
      }

      // 双人/分身/拼贴防漏审查
      if (passed && /(分身|双人|复制体|多格|分镜拼贴|并排两人)/.test(output) && !/(无分身|无双人|非双人|非分身)/.test(output)) {
        passed = false;
        reason += ' [触发分身/拼贴红线拦截]';
      }

      resolve({ passed, reason });
    });
  });
}

function findActualFile(dir: PathLike, persId: string) {
  // 兼容两种磁盘命名：首批无前缀（ref_01_face_closeup.png）与
  // 今日带前缀（<charId>_<outfitId>_ref_01_face_closeup.png）。
  const plain = path.join(dir, `${persId}.png`);
  if (fs.existsSync(plain)) return plain;
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    const match = files.find((f: any) => f.includes(persId) && f.endsWith('.png'));
    if (match) return path.join(dir, match);
  }
  return plain;
}

function getAllItems() {
  const items: any[] = [];
  for (const char of standards.characters) {
    for (const outfit of char.outfits) {
      for (const pers of standards.perspectives) {
        const key = `${char.id}/${outfit.id}/${pers.id}`;
        const targetPath = findActualFile(path.join(OUT_BASE, char.id, outfit.id), pers.id);
        items.push({
          key,
          char,
          outfit,
          pers,
          targetPath
        });
      }
    }
  }
  return items;
}

async function auditSingleItem(item: { key: unknown; char: unknown; outfit: unknown; pers: unknown; targetPath: unknown; }) {
  const pConfig = PERSPECTIVE_CONFIGS[item.pers.id];
  const isNude = item.outfit.isNsfw;
  const guide = isNude 
    ? `${pConfig.promptGuide} 特别注意：此图为全裸形态，请确认画面为纯粹裸体，无浴袍、泳装或内衣遮挡。`
    : pConfig.promptGuide;

  console.log(`🔍 [审核] [${item.char.displayName}] - [${item.outfit.name}] - [${item.pers.name}]...`);
  
  const result = await runVisionInspect(item.targetPath, guide);
  if (result.passed) {
    console.log(`  ✓ 判定通过: ${item.key}`);
    auditReport[item.key] = { passed: true, verifiedAt: new Date().toISOString() };
  } else {
    console.log(`  ❌ 判定不通过: ${item.key}`);
    auditReport[item.key] = { passed: false, reason: result.reason.slice(0, 150), verifiedAt: new Date().toISOString() };
  }
  saveReport();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
纯视觉审核器 — assets/character-references 4并发

用法:
  node scripts/maintenance/pure-vision-audit.js [--force] [--keys k1,k2] [--help]

参数:
  --force          忽略已审记录，强制重审（用于重渲染后复审）
  --keys <list>    仅审核指定 key，用逗号分隔，支持前缀匹配
                   例: --keys alisa_mikhailovna_kujou/school_uniform/ref_01_face_closeup
                       --keys frieren/nsfw_nude
  --help, -h       显示此帮助

说明:
  默认跳过已审的 pass/fail，避免无限重审；重渲染后的图 previously 需 --force 或手动清理 runtime/multi-outfit-audit-report.json
`);
    return;
  }
  const force = args.includes('--force');
  const keysArg = args.find((a: any) => a.startsWith('--keys='));
  const keysValue = keysArg ? keysArg.split('=')[1] : (args.includes('--keys') ? args[args.indexOf('--keys') + 1] : '');
  const filterKeys = keysValue ? keysValue.split(',').map((s: any) => s.trim()).filter(Boolean) : null;

  const allItems = getAllItems();
  
  while (true) {
    // 找出磁盘上已有但尚未审核的项（默认跳过已审的 pass/fail，避免无限重审）
    // --force 强制重审；--keys 仅审指定前缀；重渲染后推荐 --force --keys <key>
    const pendingItems = allItems.filter((item: any) => {
      if (!force && auditReport[item.key]) return false;
      if (filterKeys && !filterKeys.some((k: any) => item.key === k || item.key.startsWith(k))) return false;
      if (!fs.existsSync(item.targetPath)) return false;
      const stat = fs.statSync(item.targetPath);
      return stat.size > 20000;
    });

    if (pendingItems.length === 0) {
      const passedCount = Object.values(auditReport).filter((r: any) => r.passed).length;
      console.log(`[Pure Auditor] 无待审核项。已审 ${Object.keys(auditReport).length}/${allItems.length}，通过 ${passedCount}。`);
      break;
    }

    console.log(`\n================================================`);
    console.log(`[Pure Auditor] 发现 ${pendingItems.length} 张待审核图片，启动 ${AUDIT_CONCURRENCY} 并发视觉审核...`);
    console.log(`================================================\n`);

    let cursor = 0;
    async function worker() {
      while (cursor < pendingItems.length) {
        const item = pendingItems[cursor++];
        await auditSingleItem(item);
      }
    }

    const workers = Array.from({ length: AUDIT_CONCURRENCY }, (_: any, i: any) => worker(i + 1));
    await Promise.all(workers);
    saveReport();
  }
}

main().catch(console.error);
