import type { PromptPlan } from '@/types/prompt'
import { compileMossPrompt } from './mossPrompt'

/** Render shared visual facts without Anima quality, weighting or LoRA control tokens. */
export function nativeDrawingPrompt(plan: PromptPlan | null, description: string, negative: string, mode: 'moss' | 'qwen') {
  const authored = description.trim()
  const tags = plan ? [...(mode === 'moss' || !plan.subjectProse ? [...plan.identity, ...plan.characterTokens] : []), ...plan.copyrightTokens,
    ...plan.sceneVisualFragments, ...plan.emotion, ...plan.camera, ...plan.lighting, ...plan.palette, ...plan.composition, ...plan.manual] : []
  const facts = [...new Set(tags.map(value => value.replace(/<lora:[^>]+>/gi, '').replace(/\(([^():]+):[\d.]+\)/g, '$1').replace(/_/g, ' ').trim()).filter(Boolean))]
  const prose = plan ? [mode === 'qwen' ? plan.subjectProse : '', plan.outfitProse, plan.scene?.promptProse || plan.sceneProse] : []
  const prompt = mode === 'moss' && authored.startsWith('{') ? authored
    : [...new Set([...prose, facts.join(', '), plan?.artistProse, authored].filter(Boolean))].join('\n')
  const exclude = [...new Set([negative, ...(plan?.negative ?? [])].flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean))].join(', ')
  return { raw: prompt, ...(mode === 'moss' ? compileMossPrompt(prompt, exclude) : { prompt, negative: exclude }) }
}
