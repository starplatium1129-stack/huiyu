'use strict';

/**
 * routes/video/prose.js —— H3 提示词散文派生（纯函数，零副作用）。
 *
 * 覆盖：对白语言判定、镜头/运动控制器句与冲突守卫、场景感知 soundscape/music、
 * H3 帧数网格换算。官方规范依据见各段注释（MiniMax-AI/MiniMax-H3
 * h3-prompt-writing skill base-en.txt 4.1/4.4/4.6/4.7）。
 */

// ── 控制器句数据表 ──────────────────────────────────────────────
let CAMERA = Object.freeze({
  still:'固定镜头，画面稳定，仅保留自然的微小运动。',
  push:'镜头缓慢推进，保持主体居中且运动连续。',
  pull:'镜头缓慢拉远，逐步显露环境关系。',
  pan:'镜头平稳横移，速度均匀，不要突然变焦。',
  orbit:'镜头轻微环绕主体，运动克制并保持身份稳定。',
});

let MOTION = Object.freeze({
  subtle:'主体只有呼吸、眨眼、发丝和衣摆等细微运动。',
  natural:'主体做一个清晰、自然、连续的动作，避免反复和突变。',
  expressive:'主体动作更有表现力，但肢体结构和身份始终保持一致。',
});

// H3 是自然语言模型：镜头/主体运动按官方提示词规范写成英文自然句——
// 镜头运动 = 运动类型 + 幅度 + 速度，写进镜头描述而不是堆叠标签。
let H3_CAMERA = Object.freeze({
  still:'The camera holds a static shot.',
  push:'The camera pushes in at a slow, steady pace.',
  pull:'The camera pulls out at a slow, steady pace.',
  pan:'The camera pans steadily to the side, without abrupt zooms.',
  orbit:'The camera arcs around the subject with restrained motion, keeping the composition stable.',
});

let H3_MOTION = Object.freeze({
  subtle:'The subject moves only subtly: breathing, blinking, hair and clothing swaying.',
  natural:'The subject performs one clear, natural, continuous action, avoiding repetition or abrupt changes.',
  expressive:'The subject\'s action is more expressive while body structure and identity stay consistent.',
});

// 景别（H3 是自然语言模型：写成英文自然句，官方 4.1 构图描述规范，不堆标签）。
let H3_SHOT_SIZE = Object.freeze({
  wide:{ label:'全景', line:'The scene is framed as a wide establishing shot with the full environment visible.' },
  medium:{ label:'中景', line:'The subject is framed in a medium shot from the waist up.' },
  closeup:{ label:'特写', line:'The subject is framed in a close-up on the face.' },
});

// ── 对白语言判定 ────────────────────────────────────────────────
// 官方 4.4：<d> 内只放语言标签 + 原文，逐字保留。
// 角色均出自日本动漫：平假名/片假名判定为日语（2026-08-17 用户指示
// 「角色应该说话日语」）；中日韩统一归 CJK，其余归英语。
// auto 判定仅作缺省；显式 dialogueLang 传入时恒优先（zh/ja/en 三个取值）。
let CJK_DIALOGUE_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
let JAPANESE_DIALOGUE_RE = /[\u3040-\u30ff]/;
let DIALOGUE_LANGS = Object.freeze({ auto:true, zh:true, ja:true, en:true });

function resolveDialogueLang(dialogue: string, dialogueLang: string) {
  if (dialogueLang === 'zh') return 'Chinese';
  if (dialogueLang === 'ja') return 'Japanese';
  if (dialogueLang === 'en') return 'English';
  return JAPANESE_DIALOGUE_RE.test(dialogue)
    ? 'Japanese'
    : CJK_DIALOGUE_RE.test(dialogue) ? 'Chinese' : 'English';
}

// ── 风格与声音模板 ──────────────────────────────────────────────
// H3 官方 base-en.txt 要求 [Shot 1] 开头声明整体风格与初始构图（4.1）；
// 本项目出图链路全是二次元风格，默认 2D-animated, cinematic。
// 注意：rella 画师风格属短片测试资产（make-short-film.js 脚本层注入），
// 不作为正式默认（2026-08-17 用户拍板：正式链路保持原样）。
let H3_STYLE = '2D-animated, cinematic';

// 官方 4.6/4.7：soundscape 用 1-4 句具体声音；music 写乐器/速度/节奏/动态，
// 禁止抽象情绪词（"fits the mood" 之类）或解释配乐的情绪功能。
// 无音频输入时用下面这组具体化的默认模板。
let H3_SOUNDSCAPE = 'Quiet ambient room tone with subtle movement sounds — soft fabric rustle and gentle breathing; no dialogue, no voiceover.';
let H3_MUSIC = 'Soft piano notes at a slow tempo joined by sustained low strings, volume gently rising then fading at the end.';

// ── 冲突守卫 ────────────────────────────────────────────────────
// 控制器句子与用户文案的冲突守卫（2026-08-15 审计：用户文案写「镜头缓慢推进」的
// 同时控制器默认 still 会附加静态镜头句，互相矛盾；H3 是自然语言模型，矛盾指令
// 会造成语义漂移）。文案里已出现明确的镜头运动/主体动作词时，控制器句子不再附加。
// 中文词按字面匹配；英文词用 \b 词边界防误伤（"shade" 不能命中 "she"）。
let CAMERA_MENTION_RE = /(推进|推近|推镜|推入|拉远|拉近|拉镜|横移|平移|环绕|环绕镜头|摇镜|摇摄|俯拍|仰拍|特写|推拉|运镜|镜头移|镜头从|镜头缓慢|镜头慢慢|视角转换|视角变化|\bzoom\s*(?:in|out)\b|\bpush\s*in\b|\bpull\s*out\b|\bpans?\b|\borbit\b|\barc\s*shot\b|\btracking\s*shot\b|\bdolly\b|\btilt\b|\bcamera\s*(?:moves|pushes|pulls|pans|arcs|tracks|zooms)\b|\bpov\b|\bclose-?up\b)/i;
let MOTION_MENTION_RE = /(动作|运动|转身|回头|回眸|回望|站起|起身|坐下|躺下|跳跃|跳起|跳向|起舞|奔跑|跑向|跑进|跑出|走向|走进|走出|走到|走去|走来|举手|举起|挥手|挥动|挥舞|拿起|放下|端起|拾起|扭动|张开|伸出手|抬头|低头|转头|迈步|走动|踱步|舞动|跃起|跪下|跪坐|倚|偎|靠向|推开|拉开|打开|关上|翻页|弹奏|歌唱|哼唱|呼喊|微笑|轻笑|大笑|哭泣|仰望|俯身|弯腰|抱起|行走|跑动|爬出|\bmov(?:e|es|ed|ing)\b|\bwalk(?:s|ed|ing)\b|\brun(?:s|ning)\b|\bjump(?:s|ed|ing)\b|\bturn(?:s|ed|ing)\b|\brais(?:e|es|ed|ing)\b|\breach(?:es|ed|ing)\b|\bstand(?:s|ing)\b|\bsit(?:s|ting)\b|\bdanc(?:e|es|ed|ing)\b|\blift(?:s|ed|ing)\b|\bplac(?:e|es|ed|ing)\b|\bopen(?:s|ed|ing)\b|\bclos(?:e|es|ed|ing)\b|\bblink(?:s|ed|ing)\b|\bwav(?:e|es|ed|ing)\b|\bgrab(?:s|bed|bing)\b|\bstep(?:s|ped|ping)\b|\blean(?:s|ed|ing)\b|\bstretch(?:es|ed|ing)\b|\bbend(?:s|ing)\b|\bkneel(?:s|ing)\b|\bbow(?:s|ing)\b|\bspin(?:s|ning)\b|\bswing(?:s|ing)\b|\bpunch(?:es|ed|ing)\b|\bkick(?:s|ed|ing)\b|\bnod(?:s|ded|ding)\b|\bgestur(?:e|es|ed|ing)\b|\bsmil(?:e|es|ed|ing)\b|\blaugh(?:s|ed|ing)\b|\bwhisper(?:s|ed|ing)\b|\bspeak(?:s|ing)\b|\bsay(?:s|ing)\b|\bsing(?:s|ing)\b|\bsigh(?:s|ed|ing)\b|\bbreath(?:e|es|ed|ing)\b|\bflutter(?:s|ed|ing)\b|\bsway(?:s|ed|ing)\b)/i;

function proseCarriesCameraMention(prompt: any) {
  return CAMERA_MENTION_RE.test(String(prompt || ''));
}
function proseCarriesMotionMention(prompt: any) {
  return MOTION_MENTION_RE.test(String(prompt || ''));
}

// ── 场景感知 soundscape / music ────────────────────────────────
// 场景感知 soundscape/music（官方 4.6/4.7 要求与画面实际声音对应，固定室内模板
// 会让雨夜/战场/海边的成片拿到错误的「quiet room tone」）。按信号优先级取第一条
// 命中（雨夜 → 雨，而不是夜）；未命中任何信号时回退通用模板。全部为确定性匹配。
let H3_SCENE_SOUND = Object.freeze([
  // 雷/闪电只是视觉信号（幻想场景的紫色雷光 ≠ 雷雨），不派生雨声；雨声只看雨/storm。
  { re:/雨|暴雨|雨水|雨夜|雷雨|雨滴|\brain\b|\brainfall\b|\bstorm\b|\bdownpour\b|\bdrizzle\b/i,
    sound:'Steady rain falls across the scene, drumming on rooftops and pavement, with low thunder rumbling in the distance and water dripping from surfaces.' },
  { re:/海|海滩|海滨|海浪|波浪|沙滩|\bsea\b|\bocean\b|\bbeach\b|\bwave\b/i,
    sound:'Waves roll onto the shore with soft hissing foam, while a light sea breeze carries faint distant gull cries.' },
  // 战斗音效只认明确的交战信号——持剑/佩枪的日常巡逻不该配打斗音（剑本身≠战斗）。
  { re:/战斗|打斗|刀光|决战|战场|厮杀|\bfight\b|\bbattle\b|\bcombat\b/i,
    sound:'Sharp impacts and whooshing blade cuts punctuate the scene, with heavy breathing and the scrape of feet on the ground.' },
  { re:/森林|树林|林间|山间|原野|田野|花田|神社|雪原|鸟居|\bforest\b|\bwoods\b|\bmountain\b|\bmeadow\b|\bfield\b|\bgrass\b|\bsnow\b|\bice\b|\bfrozen\b|\btorii\b|\bshrine\b/i,
    sound:'Wind moves through trees and grass with a soft rustle, while faint birdsong carries across the open space.' },
  // 浴室/温泉只认明确的沐浴词——裸 steam 会误命中咖啡/拉面的热气场景。
  { re:/温泉|浴池|浴缸|汤池|澡堂|泡汤|\bonsen\b|\bbath\b|\btub\b|\bsoak\b/i,
    sound:'Gentle water laps and ripples in the bath while steam hisses softly and warm droplets fall back into the surface.' },
  { re:/街道|街头|便利店|商店|车站|月台|电车|列车|马路|都市|城市|\bstreet\b|\bcity\b|\bshop\b|\bstation\b|\btrain\b|\bneon\b|\btraffic\b/i,
    sound:'Distant city traffic hums beneath footsteps and ambient street noise, with occasional passing vehicles.' },
  { re:/夜|深夜|夜晚|月光|\bmoonlight\b|\bnight\b/i,
    sound:'Quiet night ambience: a soft breeze and distant low hums, with subtle movement sounds nearby.' },
]);

let H3_SCENE_MUSIC = Object.freeze([
  // 配乐同理：剑随身不拔 ≠ 战斗配乐（深夜卧床持剑不该配驱动打击乐）。
  { re:/战斗|决战|战场|刀光|厮杀|\bfight\b|\bbattle\b|\bcombat\b/i,
    music:'Driving orchestral percussion at a fast tempo with surging brass and steady strings.' },
  { re:/夜|深夜|月光|孤独|寂|思念|离别|伤感|\bmoonlight\b|\bnight\b|\blonely\b|\bsad\b|\bmelancholy\b/i,
    music:'Sparse solo piano notes with wide silent gaps at a slow tempo, joined by a sustained low cello line.' },
  { re:/欢快|活力|阳光|午后|集市|庆典|祭典|\bsunny\b|\bfestival\b|\bcelebration\b|\benergetic\b/i,
    music:'Bright acoustic guitar and light percussion at a moderate tempo with a gently rising melody and clean tone.' },
]);

function deriveH3Soundscape(prompt: any) {
  let source = String(prompt || '');
  for (let i = 0; i < H3_SCENE_SOUND.length; i += 1) {
    if (H3_SCENE_SOUND[i].re.test(source)) return H3_SCENE_SOUND[i].sound;
  }
  return H3_SOUNDSCAPE;
}
function deriveH3Music(prompt: any) {
  let source = String(prompt || '');
  for (let i = 0; i < H3_SCENE_MUSIC.length; i += 1) {
    if (H3_SCENE_MUSIC[i].re.test(source)) return H3_SCENE_MUSIC[i].music;
  }
  return H3_MUSIC;
}

// ── 帧数网格 ────────────────────────────────────────────────────
// MiniMax H3 按 24fps 换算帧数后向上对齐到 17k+5 网格（模型训练网格，
// 与官方模板 ComfyMathExpression 一致：count + (5 - count % 17) % 17）。
function h3FrameCount(seconds: number) {
  let count = Math.max(5, Math.round(seconds * 24));
  return count + (5 - (count % 17)) % 17;
}

export = {
  CAMERA:CAMERA,
  MOTION:MOTION,
  H3_CAMERA:H3_CAMERA,
  H3_MOTION:H3_MOTION,
  H3_SHOT_SIZE:H3_SHOT_SIZE,
  CJK_DIALOGUE_RE:CJK_DIALOGUE_RE,
  JAPANESE_DIALOGUE_RE:JAPANESE_DIALOGUE_RE,
  DIALOGUE_LANGS:DIALOGUE_LANGS,
  resolveDialogueLang:resolveDialogueLang,
  H3_STYLE:H3_STYLE,
  H3_SOUNDSCAPE:H3_SOUNDSCAPE,
  H3_MUSIC:H3_MUSIC,
  CAMERA_MENTION_RE:CAMERA_MENTION_RE,
  MOTION_MENTION_RE:MOTION_MENTION_RE,
  proseCarriesCameraMention:proseCarriesCameraMention,
  proseCarriesMotionMention:proseCarriesMotionMention,
  H3_SCENE_SOUND:H3_SCENE_SOUND,
  H3_SCENE_MUSIC:H3_SCENE_MUSIC,
  deriveH3Soundscape:deriveH3Soundscape,
  deriveH3Music:deriveH3Music,
  h3FrameCount:h3FrameCount,
};
