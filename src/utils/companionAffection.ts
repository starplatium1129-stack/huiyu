/**
 * 桌宠好感度与互动动作规则系统
 *
 * 还原并增强 Live2D 原作者的好感度与动作权限控制：
 * 1. 0~100 好感度分级体系（Lv1 初识 ~ Lv5 永恒契约）
 * 2. 动作 Intimacy 门控（未解锁专属动作在低好感时不被随机触发）
 * 3. 互动加分机制（触发摸头/摸手等互动获得 bonus）
 * 4. 原装角色台词展示与情绪联动
 */

export interface AffectionMotionEntry {
  name: string
  file: string
  text?: string
  sound?: string
  /** 需要好感度完全等于/达到该值才能解锁 (如 100) */
  equalIntimacy?: number
  /** 最小好感度阈值 */
  minIntimacy?: number
  /** 触发时奖励的好感度加成 */
  bonus?: number
  /** 权重 (缺省 1) */
  weight?: number
}

export interface AffectionLevelInfo {
  level: number
  title: string
  minScore: number
  maxScore: number
  description: string
}

export const AFFECTION_LEVELS: readonly AffectionLevelInfo[] = [
  { level: 1, title: '初识', minScore: 0, maxScore: 24, description: '略显生疏，保持着礼貌而克制的距离' },
  { level: 2, title: '习惯', minScore: 25, maxScore: 49, description: '逐渐熟悉你的存在，偶尔会流露出真实的反应' },
  { level: 3, title: '信赖', minScore: 50, maxScore: 74, description: '对你完全放下戒备，展现出标志性的傲娇与俏皮' },
  { level: 4, title: '倾心', minScore: 75, maxScore: 99, description: '十分在意你的一举一动，悄悄珍藏与你的每个瞬间' },
  { level: 5, title: '契约', minScore: 100, maxScore: 100, description: '达到满分羁绊！解锁全量专属亲昵动作与告白台词' },
]

/** 夏目（Natsume）Live2D 原作者动作与亲密度映射规则 */
export const NATSUME_AFFECTION_RULES: Record<string, readonly AffectionMotionEntry[]> = {
  TapHead: [
    { name: '摸头1', file: 'motions/TapHead_0.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸头_0.mp3', text: '需要我帮您拧一下脸吗？主人', bonus: 5, weight: 2 },
    { name: '摸头2', file: 'motions/TapHead_1.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸头_1.mp3', text: '您满意了吗？主人', bonus: 5, weight: 2 },
    { name: '摸头3', file: 'motions/TapHead_2.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸头_2.mp3', text: '无路赛', bonus: 5, weight: 2 },
    { name: '摸头4', file: 'motions/TapHead_3.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸头_3.mp3', text: '噗，你这个大傻瓜', bonus: 5, weight: 2 },
    { name: '摸头5', file: 'motions/TapHead_4.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸头_4.mp3', text: '请主人和我一起来施展萌萌的魔法吧，来，跟我一起--萌萌Q', equalIntimacy: 100, weight: 3 },
  ],
  TapHand: [
    { name: '摸手1', file: 'motions/TapHand_0.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸手_0.mp3', text: '要来我的房间坐坐吗？一起·····喝杯茶', equalIntimacy: 100, weight: 3 },
    { name: '摸手2', file: 'motions/TapHand_1.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸手_1.mp3', text: '嗯·····', bonus: 5, weight: 2 },
  ],
  TapChest: [
    { name: '摸胸1', file: 'motions/TapChest_0.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸胸_0.mp3', text: '是嘛？激动得心脏都快跳到嗓子眼了？你可真敢想啊', weight: 2 },
    { name: '摸胸2', file: 'motions/TapChest_1.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸胸_1.mp3', text: '等下，上、上来就摸这里', equalIntimacy: 100, weight: 2 },
    { name: '摸胸3', file: 'motions/TapChest_2.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸胸_2.mp3', text: '我的胸·····不是很大······', equalIntimacy: 100, weight: 2 },
    { name: '摸胸4', file: 'motions/TapChest_3.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸胸_3.mp3', text: '很舒服吧', equalIntimacy: 100, weight: 2 },
  ],
  TapLeg: [
    { name: '摸腿1', file: 'motions/TapLeg_0.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸腿_0.mp3', text: '男生嘛，都是这样的', weight: 2 },
    { name: '摸腿3', file: 'motions/TapLeg_1.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸腿_2.mp3', text: '能不能不要盯着看来看去，很羞人的', weight: 2 },
    { name: '摸腿4', file: 'motions/TapLeg_2.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸腿_3.mp3', text: '总觉得，有一股很色的视线在盯着我', equalIntimacy: 100, weight: 3 },
  ],
  TapSkirt: [
    { name: '摸裙子1', file: 'motions/TapSkirt_0.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸裙子_0.mp3', text: '·····啊？', weight: 2 },
    { name: '摸裙子2', file: 'motions/TapSkirt_1.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸裙子_1.mp3', text: '真是大胆的偷窥方式啊', weight: 2 },
    { name: '摸裙子3', file: 'motions/TapSkirt_2.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸裙子_2.mp3', text: '是不是做了个好梦？那我马上送你去真正的天堂', weight: 2 },
    { name: '摸裙子4', file: 'motions/TapSkirt_3.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸裙子_3.mp3', text: '八嘎', weight: 2 },
    { name: '摸裙子5', file: 'motions/TapSkirt_4.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸裙子_4.mp3', text: '······你兴奋了？', weight: 2 },
  ],
  TapFoot: [
    { name: '摸脚1', file: 'motions/TapFoot_0.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸脚_0.mp3', text: '原来你是变态啊？', equalIntimacy: 100, weight: 2 },
    { name: '摸脚2', file: 'motions/TapFoot_1.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap摸脚_1.mp3', text: '被踩着就让你这么兴奋吗？', equalIntimacy: 100, weight: 2 },
  ],
  TapFrame: [
    { name: '外框1', file: 'motions/TapFrame_0.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap外框_0.mp3', text: '······装傻充愣', weight: 2 },
    { name: '外框2', file: 'motions/TapFrame_1.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap外框_1.mp3', text: '干嘛', weight: 2 },
    { name: '外框3', file: 'motions/TapFrame_2.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap外框_2.mp3', text: '这我可不负责任', weight: 2 },
    { name: '外框4', file: 'motions/TapFrame_3.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap外框_3.mp3', text: '辛苦了', weight: 2 },
    { name: '外框5', file: 'motions/TapFrame_4.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap外框_4.mp3', text: '你看，又开始发出怪叫了·····', equalIntimacy: 100, bonus: 5, weight: 2 },
    { name: '外框6', file: 'motions/TapFrame_5.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap外框_5.mp3', text: '我爱你', equalIntimacy: 100, weight: 2 },
    { name: '外框7', file: 'motions/TapFrame_6.motion3.json', sound: '/assets/live2d/natsume/sounds/Motions_Tap外框_6.mp3', text: '今后我们也要永远在一起', equalIntimacy: 100, weight: 2 },
  ],
}

/** 绫地宁宁（Nene）互动台词与好感度加成配置 */
export const NENE_AFFECTION_RULES: Record<string, readonly AffectionMotionEntry[]> = {
  TapHair: [
    { name: '摸呆毛1', file: 'motions/TapHair_0.motion3.json', sound: '/assets/live2d/nene/sounds/song_restart.mp3', text: '呀！呆毛不可以乱碰啦……', bonus: 3, weight: 2 },
    { name: '摸呆毛2', file: 'motions/TapHair_1.motion3.json', sound: '/assets/live2d/nene/sounds/song_restart.mp3', text: '呜……头发会乱掉的啦。', bonus: 3, weight: 2 },
  ],
  TapHead: [
    { name: '摸头1', file: 'motions/TapHead_0.motion3.json', sound: '/assets/live2d/nene/sounds/tap_head_shuji.mp3', text: '摸摸头会让人感到安心呢～', bonus: 5, weight: 2 },
    { name: '摸头2', file: 'motions/TapHead_1.motion3.json', sound: '/assets/live2d/nene/sounds/tap_head_shuji.mp3', text: '学弟总是把我当成小孩子一样呢……不过，并不讨厌就是了。', bonus: 5, weight: 2 },
  ],
  TapFace: [
    { name: '碰脸1', file: 'motions/TapFace_0.motion3.json', sound: '/assets/live2d/nene/sounds/tap_face_boyang.mp3', text: '脸有点烫……才没有害羞呢！', bonus: 5, weight: 2 },
  ],
  TapLeftChest: [
    { name: '左胸1', file: 'motions/TapLeftChest_0.motion3.json', sound: '/assets/live2d/nene/sounds/tap_chest_stare.mp3', text: '等、等等！那里不可以啦！', equalIntimacy: 100, weight: 2 },
  ],
  TapRightChest: [
    { name: '右胸1', file: 'motions/TapRightChest_0.motion3.json', sound: '/assets/live2d/nene/sounds/tap_chest_stare.mp3', text: '变、变态学弟……！', equalIntimacy: 100, weight: 2 },
  ],
  TapSkirt: [
    { name: '裙摆1', file: 'motions/TapSkirt_0.motion3.json', sound: '/assets/live2d/nene/sounds/tap_skirt_0721.mp3', text: '呀！裙子会被掀起来的……！', weight: 2 },
  ],
  TapBody: [
    { name: '身体1', file: 'motions/TapBody_0.motion3.json', sound: '/assets/live2d/nene/sounds/tap_body_come.mp3', text: '只要有学弟在身边，魔女的秘密好像也没那么可怕了呢。', bonus: 4, weight: 2 },
  ],
}

/** 获取好感度等级信息 */
export function getAffectionLevel(score: number): AffectionLevelInfo {
  const normalized = Math.max(0, Math.min(100, Math.round(score)))
  const found = AFFECTION_LEVELS.find(lvl => normalized >= lvl.minScore && normalized <= lvl.maxScore)
  return found || AFFECTION_LEVELS[0]
}

export interface PickedAffectionMotion {
  index: number
  entry: AffectionMotionEntry
}

/**
 * 根据角色、动作分组和当前好感度，挑选合适触发的动作索引
 */
export function pickAffectionMotion(
  character: string,
  group: string,
  currentScore: number,
  randomFn = Math.random
): PickedAffectionMotion | null {
  const rulesMap = character === 'natsume' ? NATSUME_AFFECTION_RULES : character === 'nene' ? NENE_AFFECTION_RULES : null
  if (!rulesMap) return null

  const entries = rulesMap[group]
  if (!entries || entries.length === 0) return null

  const normalizedScore = Math.max(0, Math.min(100, Math.round(currentScore)))

  // 过滤满足门控条件的动作项
  const candidates: Array<{ index: number; entry: AffectionMotionEntry; weight: number }> = []

  entries.forEach((entry, idx) => {
    // 检查 equalIntimacy（例如只有达到 100 分才能解锁）
    if (entry.equalIntimacy !== undefined && normalizedScore < entry.equalIntimacy) {
      return
    }
    // 检查 minIntimacy
    if (entry.minIntimacy !== undefined && normalizedScore < entry.minIntimacy) {
      return
    }

    // 权重计算：满分专属动作在满分时赋予更高被抽中的权重
    let weight = entry.weight ?? 1
    if (normalizedScore >= 100 && entry.equalIntimacy === 100) {
      weight *= 1.5
    }

    candidates.push({ index: idx, entry, weight })
  })

  if (candidates.length === 0) {
    return null
  }

  const totalWeight = candidates.reduce((sum, item) => sum + item.weight, 0)
  let randomVal = randomFn() * totalWeight

  for (const candidate of candidates) {
    if (randomVal <= candidate.weight) {
      return { index: candidate.index, entry: candidate.entry }
    }
    randomVal -= candidate.weight
  }

  const fallback = candidates[candidates.length - 1]
  return { index: fallback.index, entry: fallback.entry }
}

export function hasAffectionMotionRules(character: string, group: string): boolean {
  const rules = character === 'natsume' ? NATSUME_AFFECTION_RULES : character === 'nene' ? NENE_AFFECTION_RULES : undefined
  return Boolean(rules?.[group]?.length)
}
