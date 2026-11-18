import { resolveFramingMode, type PromptScene } from './sceneFraming.ts'
import type { LoraMeta } from './promptPolicyTypes.ts'

export interface LoraSpec { name: string; weight: number }

export interface SceneLoraRef { name: string; weight: number | null }

/**
 * WAI LoRA 解析器：在场景模板剥离之前读取显式 <lora:name:weight>，
 * 返回原始 name 与作者写的权重（无权重时为 null）。
 */
export function parseScenePromptLoras(scene: PromptScene | null | undefined): SceneLoraRef[] {
  const text = String(scene?.prompt || '')
  const refs: SceneLoraRef[] = []
  const re = /<lora:([^>:]+)(?::([\d.]+))?>/gi
  let match
  while ((match = re.exec(text))) {
    const name = String(match[1] || '').trim()
    if (!name) continue
    const weight = match[2] === undefined ? null : Number(match[2])
    refs.push({ name, weight: weight !== null && Number.isFinite(weight) ? weight : null })
  }
  return refs
}

/** 历史版本号迁移到 characters.json 的正式模型名。 */
function canonicalLoraName(name: string, fallbackByChar: Record<string, string>): string {
  if (/^ayachi_nene_v\d+/i.test(name) && fallbackByChar.nene) return fallbackByChar.nene
  if (/^shiki_natsume_v\d+/i.test(name) && fallbackByChar.natsume) return fallbackByChar.natsume
  return name
}

/**
 * LoRA 权重解析：
 * 场景模板里的显式 <lora:name:weight> 优先（保留作者权重）；没有时才回退到
 * scene.lora / fallbackByChar 并按镜头动态解析（双人 0.62 / 复杂 0.7 /
 * 全身 0.75 / 特写 0.85 / 默认）。
 */
export function resolveLoraSpecs(
  character: string,
  scene: PromptScene | null | undefined,
  loraMeta: LoraMeta[],
  fallbackByChar: Record<string, string>,
  context: { shot?: string | null; manualTags?: Set<string> } = {},
): LoraSpec[] {
  const promptRefs = parseScenePromptLoras(scene).map(ref => ({
    name: canonicalLoraName(ref.name, fallbackByChar),
    explicit: ref.weight,
  }))
  const refs = promptRefs.length
    ? promptRefs
    : String(scene?.lora ? scene.lora : (fallbackByChar[character] || ''))
        .split(',')
        .map(value => {
          const clean = value.trim().replace(/^<lora:/i, '').replace(/>$/, '')
          const parts = clean.split(':')
          return { name: canonicalLoraName((parts[0] || '').trim(), fallbackByChar), explicit: Number(parts[1]) }
        })
        .filter(item => item.name)
  if (!refs.length) return []

  const dual = character === 'triad' || refs.length > 1
  const complex = scene && (scene.category === '战斗' || scene.category === 'Active_Sync_Scenes')
  const mode = resolveFramingMode(context.shot, [...(context.manualTags ?? new Set<string>())])
  const wide = mode === 'wide'
  const portrait = mode === 'close'

  return refs.map(ref => {
    const meta = loraMeta.find(m => m?.name === ref.name) || null
    const recommended = meta?.recommended_weight || {}
    let base = Number(meta?.strength?.default)
    if (!Number.isFinite(base)) base = 0.8
    const weight = typeof ref.explicit === 'number' && ref.explicit > 0
      ? ref.explicit
      : dual ? 0.62
      : complex ? (Number(recommended.complex_scene) || 0.7)
      : wide ? (Number(recommended.fullbody) || 0.75)
      : portrait ? (Number(recommended.portrait) || 0.85)
      : base
    return { name: ref.name, weight: Number(Number(weight).toFixed(2)) }
  })
}

export function loraSpecText(spec: LoraSpec): string {
  return `${spec.name}:${spec.weight}`
}
