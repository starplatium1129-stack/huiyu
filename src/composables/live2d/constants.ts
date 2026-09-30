/**
 * useLive2D 纯数据常量（拆分 Step 1 自 useLive2D.ts 原样搬出）。
 * 所有事故注释都是实机实证记录，禁止改动数值与分组语义。
 */

export interface Live2DInteraction {
  group: string
  hint: string
  duration: number
}

export const INTERACTION_MOTIONS: Record<string, Live2DInteraction> = {
  Hair: { group: 'TapHair', hint: '摸了摸呆毛', duration: 5_000 },
  Head: { group: 'TapHead', hint: '摸了摸头顶', duration: 5_000 },
  Face: { group: 'TapFace', hint: '轻碰了脸颊', duration: 5_000 },
  LeftChest: { group: 'TapLeftChest', hint: '碰到了画面左侧胸前，宁宁有点生气', duration: 3_500 },
  RightChest: { group: 'TapRightChest', hint: '碰到了画面右侧胸前，宁宁有点生气', duration: 3_500 },
  Skirt: { group: 'TapSkirt', hint: '触发了裙摆互动', duration: 9_000 },
  Body: { group: 'TapBody', hint: '轻碰了身体', duration: 5_000 },
}

// 夏目模型（Live2DViewerEX 工坊解包）的互动区：头/手/胸/裙/腿/脚/外框。
// 动作分组已由 natsume-live2d-import.py 重命名为宁宁同款英文名。
export const NATSUME_INTERACTIONS: Record<string, Live2DInteraction> = {
  Head: { group: 'TapHead', hint: '摸了摸夏目的头', duration: 11_750 },
  Hand: { group: 'TapHand', hint: '握了握夏目的手', duration: 6_317 },
  Chest: { group: 'TapChest', hint: '夏目微微皱眉，咖啡差点洒了', duration: 6_150 },
  Skirt: { group: 'TapSkirt', hint: '触发了裙摆互动', duration: 7_717 },
  Leg: { group: 'TapLeg', hint: '夏目别开了视线', duration: 5_333 },
  Foot: { group: 'TapFoot', hint: '夏目轻轻缩了缩脚', duration: 6_333 },
  Frame: { group: 'TapFrame', hint: '夏目抬眼看了你一下', duration: 5_633 },
}
// 夏目 model3.json 的 HitAreas 是中文名（解包保留），映射到互动键
export const NATSUME_HIT_AREA_MAP: Record<string, string> = {
  外框: 'Frame', 摸腿: 'Leg', 摸头: 'Head', 摸手: 'Hand',
  摸胸: 'Chest', 摸脚: 'Foot', 摸裙子: 'Skirt',
}

// 夏目 model3.json 的 LipSync 组指向 ParamMouthOpenY，但 moc3 实际没有该参数；
// 说话动作（Idle_6 等）用 ParamMouthForm3（-0.5..0）驱动嘴部开合。
export const MOUTH_PARAMS: Record<string, { id: string; scale: number }> = {
  nene: { id: 'ParamMouthOpenY', scale: 1 },
  natsume: { id: 'ParamMouthForm3', scale: -0.5 },
}

// 眨眼组与 model3.json 的 Groups.EyeBlink 一致。wl-live2d 的自动眨眼在
// 循环 Idle 运动期间从不触发，且夏目各 Idle 的作者眼曲线左右眼不同步
// （ParamEyeLOpen / ParamEyeLOpen2 长时间一闭一睁）；这里统一由
// blinkScheduler 逐帧覆盖双眼参数，保证同步眨眼。
export const BLINK_PARAMS: Record<string, readonly string[]> = {
  nene: ['ParamEyeLOpen', 'ParamEyeROpen'],
  natsume: ['ParamEyeLOpen', 'ParamEyeLOpen2'],
}

// 登场动作：夏目模型加载完成后随机播一个（Live2DViewerEX 原版行为）。
// Start 运动 1.6-4.4s，眼曲线左右眼同步（Start_4 含开场闭眼），登场期间
// 暂停覆盖式眨眼，让作者动画原样呈现。宁宁没有 Start 组，自动降级为 no-op。
export const ENTRANCE_GROUP = 'Start'
export const ENTRANCE_MAX_MS = 5_200
// 告别动作：关闭 Live2D 时先播一小段 Leave（14s 的"待机最终"），再销毁。
export const LEAVE_GROUP = 'Leave'
export const LEAVE_PLAY_MS = 5_000

export const POINTER_FOCUS_PARAMS = ['ParamAngleX', 'ParamAngleY', 'ParamEyeBallX', 'ParamEyeBallY']

// 叠层/换装回落时长：原生端为 0.5s（OVERLAY_SETTLE_SECONDS）；浏览器端
// 回落起点比原生晚（互动定时器在动作时长+600ms 才交还所有权），取稍短
// 时长补偿总时长。
export const OVERLAY_SETTLE_MS = 450

// 夏目互动（Tap*）/登场（Start*）动作驱动、但 Idle 组完全未覆盖的参数
// （2026-08-15 从 motions/Tap*.motion3.json 与 Idle*.motion3.json 曲线差集
// 提取）：互动/登场动作把这些参数拉高（作者叠层/换装部件临时显隐），动作
// 结束后 idle 不带回默认值 → 叠层残留（"衣服重复显示/四只手"，官方 Notes on
// Pose Switching 场景）。动作结束必须显式写回隐藏态。
// 隐藏态按 moc3 默认值分组（2026-08-16 idle 采样实证）：多数叠层参数默认
// -1（隐藏），写 0 会落在"显示区间"导致叠层半透明残留（重影灰眼，用户
// 反馈）；Param18/44-51/56/57/62 默认 0。Param37/Param64 为 2026-08-16
// 补充（Tap 驱动但此前不在清单）。
// 依据：docs/guides/desktop/live2d-native-runtime.md 的模型特殊契约。
export const NATSUME_RESET_PARAMS: ReadonlyArray<{ id: string; value: number }> = [
  { id: 'Param18', value: 0 },
  { id: 'Param36', value: 0 },
  { id: 'Param44', value: 0 }, { id: 'Param45', value: 0 }, { id: 'Param46', value: 0 },
  { id: 'Param47', value: 0 }, { id: 'Param48', value: 0 }, { id: 'Param49', value: 0 },
  { id: 'Param50', value: 0 }, { id: 'Param51', value: 0 }, { id: 'Param56', value: 0 },
  { id: 'Param57', value: 0 }, { id: 'Param62', value: 0 },
  { id: 'Param37', value: -1 }, { id: 'Param38', value: -1 }, { id: 'Param39', value: -1 },
  { id: 'Param40', value: -1 }, { id: 'Param41', value: -1 }, { id: 'Param42', value: -1 },
  { id: 'Param43', value: -1 }, { id: 'Param52', value: -1 }, { id: 'Param53', value: -1 },
  { id: 'Param54', value: -1 }, { id: 'Param55', value: -1 }, { id: 'Param58', value: -1 },
  { id: 'Param59', value: -1 }, { id: 'Param60', value: -1 }, { id: 'Param61', value: -1 },
  { id: 'Param63', value: -1 }, { id: 'Param64', value: -1 },
  { id: 'ParamMouthForm5', value: 0 }, { id: 'ParamMouthForm6', value: 0 },
  { id: 'ParamMouthForm7', value: 0 }, { id: 'ParamMouthForm8', value: 0 },
  { id: 'ParamMouthForm9', value: 0 }, { id: 'ParamMouthForm10', value: 0 },
]
