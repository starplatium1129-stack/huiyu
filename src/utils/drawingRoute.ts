export type ManagedDrawEngine = 'sd' | 'anima' | 'krea2'
export type ManagedPromptFormat = 'danbooru' | 'anima-tags' | 'natural-language'
export type StudioCharacter = 'nene' | 'natsume' | 'triad'

export interface DrawingRouteInput {
  subjectKind: 'studio' | 'popular'
  character: StudioCharacter
  recommendedModelId?: string | null
}

export interface DrawingRouteRecommendation {
  id: 'studio-single' | 'studio-dual' | 'popular-anima' | 'popular-krea-detail'
  engine: ManagedDrawEngine
  modelId: string
  loraId: string
  generationCharacter: 'nene' | 'natsume' | null
  promptFormat: ManagedPromptFormat
  title: string
  summary: string
  reasons: readonly string[]
  experimental: boolean
}

const STUDIO_LORA = Object.freeze({
  nene: Object.freeze({
    loraId: 'L_NENE_V21_ANIMA',
    generationCharacter: 'nene' as const,
    label: '宁宁 V21',
  }),
  natsume: Object.freeze({
    loraId: 'L_NAT_V21_ANIMA',
    generationCharacter: 'natsume' as const,
    label: '夏目 V21',
  }),
})

/**
 * 场景模式只表达创作意图，技术路线由这里统一决定。
 * 新增 ComfyUI 工作流时应注册成新的受控路线，不把节点或 Prompt 语法暴露给用户。
 */
export function recommendDrawingRoute(input: DrawingRouteInput): DrawingRouteRecommendation {
  if (input.subjectKind === 'popular') {
    if (input.recommendedModelId === 'krea2-turbo-fp8') {
      // 2026-08-23 链路替换：实测社区增强链路与原标准链路出图时间一致，
      // 原 euler 标准路线退役，Krea 2 推荐固定走增强链路（网关侧已无关闭开关）。
      return {
        id: 'popular-krea-detail',
        engine: 'krea2',
        modelId: 'krea2-turbo-fp8',
        loraId: '',
        generationCharacter: null,
        promptFormat: 'natural-language',
        title: '热门角色细节增强路线',
        summary: 'Krea 2 · 社区增强链路 · 细节补丁与锐化',
        reasons: [
          '按角色资料使用推荐底模，系统自动整理为自然语言画面描述',
          '启用社区验证的 Krea2T-Enhancer 细节补丁与 RCAS 锐化',
          'er_sde 配 8 步 Turbo，实测出图速度与原标准链路持平',
        ],
        experimental: true,
      }
    }
    return {
      id: 'popular-anima',
      engine: 'anima',
      modelId: 'anima-miaomiao-v1.6',
      loraId: '',
      generationCharacter: null,
      promptFormat: 'anima-tags',
      title: '热门角色通用高质路线',
      summary: 'MiaoMiao Harem v1.6 · 模型原生标签 · 无角色 LoRA',
      reasons: [
        '热门角色不混入宁宁或夏目的 LoRA',
        '身份、服装和场景蓝图由系统组合',
      ],
      experimental: false,
    }
  }

  if (input.character === 'triad') {
    return {
      id: 'studio-dual',
      engine: 'sd',
      modelId: 'waiIllustriousSDXL_v170',
      loraId: '',
      generationCharacter: null,
      promptFormat: 'danbooru',
      title: '双人稳定路线',
      summary: 'WAI v17 · Danbooru 标签 · 宁宁/夏目双 LoRA',
      reasons: [
        '双角色身份需要同时加载两套 LoRA',
        '沿用已经验证的双人构图与负面词策略',
      ],
      experimental: false,
    }
  }

  const studio = STUDIO_LORA[input.character]
  return {
    id: 'studio-single',
    engine: 'anima',
    modelId: 'anima-miaomiao-v1.6',
    loraId: studio.loraId,
    generationCharacter: studio.generationCharacter,
    promptFormat: 'anima-tags',
    title: '角色高质量路线',
    summary: `MiaoMiao Harem v1.6 · ${studio.label} · 模型原生标签`,
    reasons: [
      '优先使用当前角色已验证的高质量 LoRA',
      '采用 MiaoMiao v1.6 对应的模型 profile 与角色绑定',
      '底模、Prompt 结构和稳定参数自动保持一致',
    ],
    experimental: false,
  }
}

export function promptFormatLabel(format: ManagedPromptFormat): string {
  if (format === 'danbooru') return 'Danbooru 标签'
  if (format === 'natural-language') return '自然语言画面描述'
  return 'Anima 模型原生标签'
}
