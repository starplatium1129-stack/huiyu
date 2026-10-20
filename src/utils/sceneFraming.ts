export interface PromptScene {
  compositionIntent?: import('../types/sceneBlueprint').BlueprintCompositionIntent
  char?: string
  prompt?: string
  tags?: string[]
  lora?: string
  category?: string
  rating?: string
  mature?: boolean
  negative?: string
  camera?: unknown
}

/** POV/俯仰角与景别可并存；角度不能使明确的近景/全身约束失效。 */
export function framingShot(shot: string | null | undefined, camera: unknown): string | null | undefined {
  if (!shot || ['close', 'detail', 'medium', 'wide'].includes(shot)) return shot
  const text = String(camera || '').toLowerCase()
  if (/特写|近景|close[-_ ]?up|portrait/.test(text)) return 'close'
  if (/全身|远景|wide[-_ ]?shot|full[-_ ]?body/.test(text)) return 'wide'
  if (/半身|中景|medium[-_ ]?shot/.test(text)) return 'medium'
  return shot
}
