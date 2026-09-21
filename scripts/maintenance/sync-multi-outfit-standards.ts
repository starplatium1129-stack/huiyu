#!/usr/bin/env node
'use strict';

/**
 * 构建「多角色 × 多服装/形态 (Multi-Outfit & Full Nude NSFW Form)」4 视角标准参考资产体系
 *
 * 规范：
 * 每个角色均包含：
 * 1. 调研的常规服装（校服、日常、礼服、战衣等）
 * 2. 🔞 纯粹全裸形态 (Full Nude / Uncensored Body Form)：用于锁死纯粹身体、肤质、胸腰比例与成人短剧基准
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const referenceStore: typeof import('../lib/reference-store') = require('../lib/reference-store');
const { mergeReferenceLibrary }: typeof import('../lib/reference-library-merge') = require('../lib/reference-library-merge');

const ROOT = path.resolve(process.env.AICS_DATA_ROOT || process.env.AICS_APP_ROOT || path.join(__dirname, '..', '..'));
// 2026-08-29：参考图迁出项目 → AI 工作区 CharacterReferences（样张模式，桌面
// 安装包不再携带 ~1GB 媒体图）；找不到外部目录时退回项目 assets 兼容旧环境。
const OUT_BASE = (() => {
  const ws = process.env.AI_WORKSPACE_ROOT || path.resolve(ROOT, '..', 'AI');
  const candidate = path.join(ws, 'CharacterReferences');
  return fs.existsSync(candidate) ? candidate : path.join(ROOT, 'assets', 'character-references');
})();

const PERSPECTIVES = [
  {
    id: "ref_01_face_closeup",
    name: "面部特写",
    shotType: "特写 · 85mm 浅景深",
    lens: "85mm f/1.4 Portrait Lens",
    targetUsage: ["对白特写", "微表情", "情绪反应镜头", "台词对峙"]
  },
  {
    id: "ref_02_half_medium",
    name: "3/4半身定妆",
    shotType: "半身 · 中景",
    lens: "50mm Medium Lens",
    targetUsage: ["对话交互", "过肩推拉", "室内中景", "双人互动"]
  },
  {
    id: "ref_03_full_dynamic",
    name: "正面全身立姿",
    shotType: "全身 · 广角 50mm",
    lens: "50mm Wide Frame",
    targetUsage: ["登场走入", "全景走位", "全身动作", "空间交代"]
  },
  {
    id: "ref_04_back_rear",
    name: "45°侧后背影",
    shotType: "侧后 · 轮廓光",
    lens: "85mm Cinematic Edge",
    targetUsage: ["过肩反打", "转身离去", "背影叙事", "神秘氛围"]
  }
];

// 2026-08-31 设计图基线视角（占位）：供视频 3渲2 角色卡锁身份用的标准三视图
// （严格正/侧/背 + 对称站姿 + 纯灰背景 + 均匀光）。当前为「空位」——只进
// standards/view 的 perspectives 与 references（pending: true 标记、无 url），
// 不出资产校验过滤（见 assetBackedOutfits 仅按 PERSPECTIVES 校验），出图批量补做。
const DESIGN_PERSPECTIVES = [
  {
    id: "ref_design_front",
    name: "设计图·正面",
    shotType: "正面 · 对称站姿",
    lens: "Standard Design Sheet",
    targetUsage: ["3渲2 角色卡正面", "身份锁定", "服装正面结构"]
  },
  {
    id: "ref_design_side",
    name: "设计图·侧面",
    shotType: "侧面 90° · 对称站姿",
    lens: "Standard Design Sheet",
    targetUsage: ["3渲2 角色卡侧面", "发型厚度", "服装层次"]
  },
  {
    id: "ref_design_back",
    name: "设计图·背面",
    shotType: "背面 90° · 对称站姿",
    lens: "Standard Design Sheet",
    targetUsage: ["3渲2 角色卡背面", "背后服装结构", "发型背面轮廓"]
  }
];

// 核心主角专属服装形态
const HEROINE_CHARACTERS = [
  {
    id: "nene",
    displayName: "绫地宁宁",
    originalName: "Ayachi Nene",
    source: "YUZUSOFT《サノバウィッチ》",
    identityProse: "Ayachi Nene, a gentle and beautiful girl with long silver hair tied in elegant low twintails, an expressive ahoge, delicate pink hair ribbons, deep violet eyes",
    identityTokens: ["ayachi_nene", "1girl", "solo", "silver_hair", "long_hair", "low_twintails", "purple_eyes", "ahoge", "hair_ribbon", "pink_ribbon"],
    outfits: [
      {
        id: "witch_canonical",
        name: "经典魔女服",
        isDefault: true,
        prose: "wearing her signature black witch outfit with a pointed witch hat, black cape, criss-cross halter crop top with pink bow, black pleated skirt, and asymmetrical striped thigh-highs",
        tokens: ["nene_witch_canonical", "witch_hat", "black_cape", "criss-cross_halter", "crop_top", "strap_between_breasts", "pink_bow", "black_skirt", "asymmetrical_legwear", "striped_thighhighs"]
      },
      {
        id: "school_uniform",
        name: "学院校服",
        prose: "wearing her neat high school uniform with white collared shirt, navy blazer, school tie, and pleated navy skirt with black knee socks",
        tokens: ["school_uniform", "blazer", "white_shirt", "collared_shirt", "necktie", "pleated_skirt", "knee_socks"]
      },
      {
        id: "casual_summer",
        name: "日常夏装",
        prose: "wearing a comfortable casual light pastel summer dress with delicate floral accents and white flat shoes",
        tokens: ["casual", "summer_dress", "sundress", "flat_shoes"]
      },
      {
        id: "nsfw_nude",
        name: "私密全裸 / 纯粹形态",
        isNsfw: true,
        prose: "completely naked, full nudity, bare skin, natural female body, medium breasts, pink nipples, slender waist, navel, bare legs and bare feet, intimate soft bedroom lighting",
        tokens: ["nude", "completely_naked", "uncensored", "breasts", "nipples", "navel", "bare_shoulders", "collarbone", "bare_legs", "bare_feet"]
      }
    ]
  },
  {
    id: "natsume",
    displayName: "四季夏目",
    originalName: "Shiki Natsume",
    source: "YUZUSOFT《喫茶ステラと死神の蝶》",
    identityProse: "Shiki Natsume, a cool and refined young woman with silky long straight black hair, amber golden eyes, a subtle distinct mole under her left eye, side hairclip",
    identityTokens: ["shiki_natsume", "1girl", "solo", "black_hair", "long_hair", "amber_eyes", "mole_under_eye", "mole_under_left_eye", "hairclip", "side_hairclip"],
    outfits: [
      {
        id: "cafe_uniform",
        name: "Café Stella 制服",
        isDefault: true,
        prose: "wearing the elegant Café Stella uniform with a crisp collared white shirt, neat necktie, dark work apron, tailored brown pleated skirt, and black thigh-highs",
        tokens: ["natsume_cafe_uniform", "cafe_uniform", "apron", "white_shirt", "collared_shirt", "necktie", "brown_skirt", "pleated_skirt", "black_thighhighs"]
      },
      {
        id: "casual_knit",
        name: "秋冬针织私服",
        prose: "wearing a cozy oversized knit beige sweater, dark mini skirt, warm woolen scarf, and black tights",
        tokens: ["casual", "sweater", "knit_sweater", "scarf", "black_tights", "mini_skirt"]
      },
      {
        id: "nsfw_nude",
        name: "私密全裸 / 纯粹形态",
        isNsfw: true,
        prose: "completely naked, full nudity, bare skin, natural slender female body, delicate small breasts, pink nipples, mole under eye visible, slender waist, navel, bare legs, soft warm ambient lighting",
        tokens: ["nude", "completely_naked", "uncensored", "small_breasts", "breasts", "nipples", "navel", "bare_shoulders", "collarbone", "bare_legs", "bare_feet"]
      }
    ]
  }
];

function buildMultiOutfitMatrix() {
  const popularRaw = { characters: (require('../lib/popular-store') as typeof import('../lib/popular-store')).loadPopularShards().characters };
  const allCharacters = [...HEROINE_CHARACTERS];

  for (const p of popularRaw.characters || []) {
    const rawOutfits = p.outfits || [];
    const defaultIndex = Math.max(0, rawOutfits.findIndex((o: any) => o.default === true || o.isDefault === true));
    const formattedOutfits = rawOutfits.map((o: any, idx: number) => ({
      id: o.id,
      name: o.name,
      isDefault: idx === defaultIndex,
      prose: o.prose || '',
      tokens: o.tokens || [],
      isNsfw: Boolean(o.name.includes('私密') || o.name.includes('泳装') || o.name.includes('浴') || o.id.includes('nsfw') || o.name.includes('裸'))
    }));

    // 2026-08-29 审计 P0-1：popular-characters 已含 nsfw_nude 时不得重复追加，
    // 否则 standards/view 各多出一条重复形态（曾致 25 角色各 2 条 nsfw_nude）。
    if (!formattedOutfits.some((o: { id: string; }) => o.id === "nsfw_nude")) {
      formattedOutfits.push({
        id: "nsfw_nude",
        name: "私密全裸 / 纯粹形态",
        isDefault: false,
        isNsfw: true,
        prose: `completely naked, full nudity, bare skin, natural female body, breasts, pink nipples, slender waist, navel, bare shoulders, collarbone, bare legs, bare feet, clean soft cinematic studio lighting`,
        tokens: ["nude", "completely_naked", "uncensored", "breasts", "nipples", "navel", "bare_shoulders", "collarbone", "bare_legs", "bare_feet"]
      });
    }

    // 2026-08-29 审计 P0-1：幽灵形态（磁盘无任何参考图资产）不得写入 standards/view，
    // 否则 check-ref-urls 断链门禁报红；形态仍保留在 popular-characters.json 供出图提示词使用。
    const assetBackedOutfits = formattedOutfits.filter((o: { id: string; }) => {
      if (PERSPECTIVES.every((persp: any) => fs.existsSync(path.join(OUT_BASE, p.id, o.id, `${persp.id}.png`)))) return true;
      return PERSPECTIVES.every((persp: any) => fs.existsSync(path.join(OUT_BASE, p.id, `${persp.id}.png`)));
    });

    allCharacters.push({
      id: p.id,
      displayName: p.displayName,
      originalName: p.originalName,
      source: p.franchise,
      identityProse: p.identityProse,
      identityTokens: p.identityTokens || [],
      outfits: assetBackedOutfits
    });
  }

  // 写入 JSON 规范
  const standardsData = {
    version: 2,
    schema: "character-reference-standards-v2",
    description: "角色 × 多服装形态（含全裸私密形态）短剧 4 视角标准参考资产库 + 3 视角设计图基线（占位）",
    perspectives: [...PERSPECTIVES, ...DESIGN_PERSPECTIVES],
    characters: allCharacters
  };

  // 构建 TS 运行时契约
  const tsRecord: Record<string, any> = {};
  for (const c of allCharacters) {
    tsRecord[c.id] = {
      characterId: c.id,
      displayName: c.displayName,
      source: c.source,
      identityProse: c.identityProse,
      outfits: c.outfits.map((o: any) => {
        const outfitDir = path.join(OUT_BASE, c.id, o.id);
        const hasCustomDir = fs.existsSync(outfitDir);
        return {
          outfitId: o.id,
          outfitName: o.name,
          isDefault: Boolean(o.isDefault),
          isNsfw: Boolean(o.isNsfw),
          prose: o.prose,
          references: [
            ...PERSPECTIVES.map((p: any) => ({
              id: p.id,
              name: p.name,
              shotType: p.shotType,
              lens: p.lens,
              targetUsage: p.targetUsage,
              fileName: `${p.id}.png`,
              url: hasCustomDir
                ? `/character-references/${c.id}/${o.id}/${p.id}.png`
                : `/character-references/${c.id}/${p.id}.png`
            })),
            // 2026-08-31 设计图基线占位：pending 无 url（图未生成），前端渲染占位卡、
            // check-ref-urls 门禁跳过；批量出图后去掉 pending 填 url。
            ...DESIGN_PERSPECTIVES.map((p: any) => ({
              id: p.id,
              name: p.name,
              shotType: p.shotType,
              lens: p.lens,
              targetUsage: p.targetUsage,
              fileName: `${p.id}.png`,
              url: '',
              pending: true
            }))
          ]
        };
      })
    };
  }

  const merged = mergeReferenceLibrary(referenceStore.readReferenceLibrary(ROOT), { standards: standardsData, view: tsRecord });
  referenceStore.writeReferenceLibrary(ROOT, merged.standards, merged.view);
  console.log(`[Full Nude Matrix Sync] 已合并写入 ${Object.keys(tsRecord).length} 位角色 -> data/character-reference-view.json`);
}

buildMultiOutfitMatrix();
