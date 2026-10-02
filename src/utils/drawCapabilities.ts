import type { DrawCapabilities, ModelProfile, PromptEngine } from '@/utils/promptPolicy'

/**
 * 引擎能力默认值表 —— 唯一权威的“引擎默认能做什么”。
 *
 * 业务代码不应再写 `engine === 'krea2'` 这类散落分支来判断能力；
 * 应通过 resolveDrawCapabilities() 拿到合并后的能力表，再决定 UI/组装行为。
 */
export const ENGINE_DEFAULT_CAPABILITIES: Record<PromptEngine, DrawCapabilities> = Object.freeze({
  sd: Object.freeze({
    negative: true,
    lora: true,
    noLora: false,
    characterIdentity: true,
    dualCharacter: true,
    hires: true,
    teaCache: false,
    weightSyntax: true,
    promptFormat: 'danbooru',
    experimental: false,
  }),
  anima: Object.freeze({
    negative: true,
    lora: true,
    noLora: false,
    characterIdentity: true,
    dualCharacter: false,
    hires: true,
    teaCache: true,
    weightSyntax: true,
    promptFormat: 'anima-tags',
    experimental: false,
  }),
  krea2: Object.freeze({
    negative: false,
    lora: false,
    noLora: true,
    characterIdentity: false,
    dualCharacter: false,
    hires: false,
    teaCache: false,
    weightSyntax: false,
    promptFormat: 'natural-language',
    experimental: true,
  }),
})

/**
 * 合并能力：引擎默认值 < profile.capabilities < 后端模型 capabilities。
 * 这样未来新增引擎/底模时，只需在对应表里声明能力，UI 与编译器自动跟随。
 */
export function resolveDrawCapabilities(
  engine: PromptEngine,
  profile?: ModelProfile | null,
  modelCapabilities?: Partial<DrawCapabilities> | null,
): DrawCapabilities {
  return {
    ...ENGINE_DEFAULT_CAPABILITIES[engine],
    ...(profile?.capabilities || {}),
    ...(modelCapabilities || {}),
  }
}

/** 便捷判断：当前引擎是否使用自然语言散文（Krea2 类）。 */
export function isNaturalLanguage(capabilities: Pick<DrawCapabilities, 'promptFormat'>): boolean {
  return capabilities.promptFormat === 'natural-language'
}
