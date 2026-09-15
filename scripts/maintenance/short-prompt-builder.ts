// 短标签 prompt 构建器（sc300 手工链路执行化）：
// 角色完整锚点 + 1 套服装 + 克制场景实体 + 单一动作/情绪
// + 显式评级 + LoRA 质量控制词 + Anima 画师词 + 氛围 + 三质量词。
const promptContract: typeof import('./quality-prompt-contract.js') = require('./quality-prompt-contract.js');

const CHAR_PROMPT: any = {
  nene: ['ayachi_nene', '1girl', 'solo', 'white_hair', 'very_long_hair', 'low_twintails', 'purple_eyes', 'ahoge', 'pink_hair_ribbons'],
  natsume: ['shiki_natsume', '1girl', 'solo', 'very_long_black_hair', 'golden_yellow_eyes', 'two_red_hairclips', 'mole_under_eye', 'no_hair_ribbon'],
};

// canonical 服装词映射：tag 匹配 → LoRA canonical 词（仅存在于 contract 的词）。
const CANONICAL_OUTFIT: any = {
  nene: [
    [/school_uniform|sailor/, 'nene_school_uniform'],
    [/sailor_uniform/, 'nene_sailor_uniform'],
    [/red_cardigan/, 'nene_red_cardigan_uniform'],
    [/witch/, 'nene_witch_canonical'],
    [/pajamas/, 'nene_blue_pajamas'],
    [/sleepwear|sleep/, 'nene_green_sleepwear'],
    [/bat/, 'nene_bat_dress'],
    [/black_dress/, 'nene_black_dress'],
  ],
  natsume: [
    [/cafe_uniform/, 'natsume_cafe_uniform'],
    [/pink_cafe/, 'natsume_pink_cafe_uniform'],
    [/qipao/, 'natsume_official_qipao'],
    [/maid/, 'natsume_maid_uniform'],
    [/winter_coat/, 'natsume_winter_coat'],
    [/sleepwear|sleep|pajamas/, 'natsume_sleepwear'],
  ],
};

const OUTFIT_DETAILS: any = {
  nene_school_uniform: ['blazer', 'yellow_bowtie', 'plaid_skirt', 'black_thighhighs'],
  nene_sailor_uniform: ['grey_sailor_collar', 'black_shirt', 'sailor_shirt'],
  nene_red_cardigan_uniform: ['cardigan', 'white_shirt', 'pleated_skirt', 'black_skirt'],
  nene_witch_canonical: ['witch_hat', 'black_cape', 'criss-cross_halter', 'crop_top'],
  nene_blue_pajamas: ['pajamas', 'cat_print', 'long_sleeves'],
  nene_green_sleepwear: ['nightgown', 'polka_dot', 'short_sleeves'],
  nene_bat_dress: ['black_dress', 'bat_hair_ornament', 'garter_straps'],
  nene_black_dress: ['black_dress', 'garter_straps', 'thighhighs'],
  natsume_cafe_uniform: ['white_shirt', 'suspender_skirt', 'brown_skirt', 'purple_ribbon'],
  natsume_pink_cafe_uniform: ['pink_shirt', 'pink_skirt', 'white_apron', 'frills'],
  natsume_official_qipao: ['china_dress', 'red_dress', 'floral_print', 'side_slit'],
  natsume_maid_uniform: ['maid', 'white_apron', 'maid_headdress', 'frills'],
  natsume_winter_coat: ['coat', 'fur_trim', 'hair_flower'],
  natsume_sleepwear: ['blue_shirt', 'pillow', 'on_bed'],
};

// tag 类别权重：越靠前越核心（0 = 必保留）
const PRIORITY: any = {
  hair_ribbon: 0, ahoge: 0, mole_under_eye: 0, two_red_hairclips: 0, no_hair_ribbon: 0,
  looking_at_viewer: 1, eye_contact: 1, smile: 1, gentle_smile: 1, shy_smile: 1,
  blush: 2, shy: 2, heavy_blush: 2, panicked: 2, open_mouth: 2, happy: 2, smile_face: 2,
  holding_papers: 3, holding_gift: 3, holding_spoon: 3, holding_papers_in_other_arm: 3,
  one_hand_adjusting_hair_ribbon: 3, sitting: 3, standing: 3, walking: 3, leaning: 3,
  looking_back: 3, over_shoulder: 3, lying: 3,
  classroom: 4, cafe: 4, bedroom: 4, street: 4, shrine: 4, beach: 4, library: 4,
  park: 4, rooftop: 4, kitchen: 4, train: 4, station: 4, river: 4, festival: 4,
  classroom_window: 4, window: 4, door: 4, garden: 4, forest: 4, lake: 4, sea: 4,
  snow: 5, snowfall: 5, rain: 5, clear_sky: 5, night: 5, afternoon: 5, morning: 5, day: 5,
  lantern_light: 6, window_light: 6, moonlight: 6, warm_lighting: 6, backlighting: 6,
  christmas_lights: 6, lanterns: 6, fireworks: 6, candlelight: 6, neon: 6, sunset: 6,
  medium_shot: 7, upper_body: 7, close_up: 7, full_body: 7, three_quarter_view: 7,
};

const AMBIENCE: any = {
  window: 'window_light, soft_lighting',
  golden: 'golden_hour, rim_light',
  back: 'backlit, rim_light',
  moon: 'moonlight, cool_lighting',
  lantern: 'lantern_light, warm_lighting',
  overcast: 'overcast, soft_diffused_light',
  day: 'soft_lighting, rim_light',
};

const LIGHT_KW = [
  [/window|窗/, 'window'], [/golden hour|golden|逆光|夕|sunset|dusk/, 'golden'],
  [/backlight|backlit|rim/, 'back'], [/moon|月|夜/, 'moon'], [/lantern|烛|candle|灯/, 'lantern'],
  [/campfire|bonfire|firelight|篝火|火光/, 'lantern'],
];

function pickLighting(lighting: string) {
  const hay = String(lighting || '').toLowerCase();
  for (const [re, key] of LIGHT_KW) if (re.test(hay)) return key;
  return '';
}

function fallbackLighting(scene: any) {
  const time = normalizeKey([scene.timeOfDay, scene.time, ...(scene.tags || [])].filter(Boolean).join(' '));
  if (/night|midnight|moon|夜/.test(time)) return 'moon';
  if (/sunset|dusk|evening|golden|夕|傍晚/.test(time)) return 'golden';
  if (/rain|overcast|cloud|雨|阴|曇/.test(time)) return 'overcast';
  return 'day';
}

function structuredSceneTokens(scene: any) {
  const locationMap: any = {
    教室: 'classroom',
    天台: 'rooftop',
    卧室: 'bedroom',
    咖啡店: 'cafe',
    图书馆: 'library',
    神社: 'shrine',
    海边: 'beach',
    室内场景: 'indoor',
  };
  const weatherMap: any = {
    晴: 'clear_sky',
    雨: 'rain',
    雪: 'snow',
    阴: 'overcast',
  };
  return [
    scene.timeOfDay,
    locationMap[String(scene.location || '').trim()],
    weatherMap[String(scene.weather || '').trim()],
  ].filter(Boolean);
}

function sourceTokens(scene: any) {
  const prompt = String(scene.prompt || '')
    .replace(/<lora:[^>]+>/gi, '')
    .split(',')
    .map((token: any) => token.trim())
    .filter(Boolean);
  return [
    ...structuredSceneTokens(scene),
    ...(Array.isArray(scene.tags) ? scene.tags : []),
    ...prompt,
  ];
}

function canonicalFor(characterId: string|number, tags: any[]) {
  const rules = CANONICAL_OUTFIT[characterId] || [];
  const hay = tags.join(' ');
  for (const [re, token] of rules) if (re.test(hay)) return token;
  return '';
}

const CATEGORY_LIMITS: any = Object.freeze({
  emotion: 1,
  action: 1,
  place: 2,
  weather: 1,
  prop: 1,
  entity: 2,
});

const SOURCE_METADATA = new Set([
  'official_cg', 'visual_audited',
  'nene', 'natsume', 'visual_novel_event_cg',
]);
const MIN_TOKEN_COUNT = 22;
const MAX_TOKEN_COUNT = 26;

function buildShortPrompt(scene: any, characterId: string|number) {
  const anchors = CHAR_PROMPT[characterId] || [];
  const tags = sourceTokens(scene);
  const canonical = canonicalFor(characterId, tags);
  const skip = new Set(anchors.map(normalizeKey));
  const sceneTokens: any[] = [];
  const structuralSupport: any[] = [];
  for (const tag of tags) {
    const key = normalizeKey(tag);
    if (skip.has(key)) continue;
    if (/^(?:2girls|1girl|solo)$/.test(key)) continue;
    if (key.startsWith('nene_') || key.startsWith('natsume_')) continue;
    if (promptContract.isStructuralToken(key, characterId)) {
      structuralSupport.push(tag);
      continue;
    }
    sceneTokens.push({ key, tag, priority: PRIORITY[key] !== undefined ? PRIORITY[key] : 5 });
  }
  sceneTokens.sort((a: any, b: any) => a.priority - b.priority);
  const lighting: any = pickLighting([
    scene.lighting,
    scene.time,
    scene.timeOfDay,
    ...tags.filter((tag: any) => /light|lighting|moon|sun|dusk|dawn|night|candle|lantern|fire|光|灯|月|夕|夜/i.test(String(tag))),
  ].filter(Boolean).join(' ')) || fallbackLighting(scene);
  const ambience = AMBIENCE[lighting] || '';
  const isAdult = String(scene.rating || '').toUpperCase() === 'R18' || scene.mature === true;
  const ratingToken = isAdult ? 'nsfw' : 'safe';
  // canonical 词负责锁定服装，最多两个细节词保留辨识度，避免服装词挤占场景预算。
  const outfit = canonical ? [canonical, ...(OUTFIT_DETAILS[canonical] || []).slice(0, 2)] : [];
  const fixedTokens = [...new Set([
    ...anchors,
    ...outfit,
    promptContract.QUALITY_CONTROL_TOKEN[characterId],
    ratingToken,
    ...promptContract.REQUIRED_ARTISTS,
    ...(ambience ? ambience.split(', ') : []),
    ...promptContract.QUALITY_TOKENS,
  ].filter(Boolean))];
  const sceneBudget = Math.max(0, MAX_TOKEN_COUNT - fixedTokens.length);
  const picked: any[] = [];
  const seen = new Set();
  const counts: Record<string, any> = {};
  let entityCount = 0;
  let actionEmotionCount = 0;
  // 类别配额：保证地点/天气/道具不被表情词挤掉（sc021 教训）。
  for (const item of sceneTokens) {
    if (picked.length >= sceneBudget) break;
    const key = normalizeKey(item.tag);
    if (seen.has(key) || SOURCE_METADATA.has(key)) continue;
    let category = promptContract.categoryOf(key);
    if (!category) category = 'entity';
    if (counts[category] >= CATEGORY_LIMITS[category]) continue;
    const isEntity = category === 'place' || category === 'weather'
      || category === 'prop' || category === 'entity';
    const isActionEmotion = category === 'action' || category === 'emotion';
    if (isEntity && entityCount >= 4) continue;
    if (isActionEmotion && actionEmotionCount >= 2) continue;
    seen.add(key);
    counts[category] = (counts[category] || 0) + 1;
    if (isEntity) entityCount += 1;
    if (isActionEmotion) actionEmotionCount += 1;
    picked.push(item.tag);
  }
  const support: any[] = [];
  const occupied = new Set([...fixedTokens, ...picked].map(normalizeKey));
  for (const tag of structuralSupport) {
    if (fixedTokens.length + picked.length + support.length >= MIN_TOKEN_COUNT) break;
    const key = normalizeKey(tag);
    if (!key || occupied.has(key) || SOURCE_METADATA.has(key)) continue;
    occupied.add(key);
    support.push(tag);
  }
  const prompt = [
    ...anchors,
    ...outfit,
    ...picked,
    ...support,
    promptContract.QUALITY_CONTROL_TOKEN[characterId],
    ratingToken,
    ...promptContract.REQUIRED_ARTISTS,
    ...(ambience ? ambience.split(', ') : []),
    ...promptContract.QUALITY_TOKENS,
  ].filter(Boolean).join(', ');
  const health = promptContract.inspectShortPrompt(prompt, {
    character: characterId,
    rating: isAdult ? 'R18' : 'ALL',
  });
  return { prompt, health };
}

function normalizeKey(value: string) {
  return String(value || '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
}

export = {
  buildShortPrompt,
  CHAR_PROMPT,
  CANONICAL_OUTFIT,
  OUTFIT_DETAILS,
  CATEGORY_LIMITS,
  MIN_TOKEN_COUNT,
  MAX_TOKEN_COUNT,
};
