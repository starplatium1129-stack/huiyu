import type { WorkbenchForm } from './keyframeDraft'

export interface KeyframeTag {
  id: string
  label: string
  directive: string
}

interface KeyframeIntent {
  kind: WorkbenchForm['kind']
  subjectVersionId: string
  faceVersionId?: string
  garmentVersionId?: string
  editPartsOnly?: boolean
  sceneVersionId?: string
  setting?: string
  choices: readonly KeyframeTag[]
}

const identity = 'Preserve the face shape, iris color, hairstyle, signature hair ornament, body proportions and anime linework of <Picture 1>.'
const flatLight = 'Use a flat solid #EAECEF background, even neutral studio lighting and a single subject. No text, layout panels or unrelated props.'

export function compileH3Tags(intent: KeyframeIntent) {
  const references = [intent.subjectVersionId]
  function picture(id: string) {
    let slot = references.indexOf(id)
    if (slot < 0) slot = references.push(id) - 1
    return `<Picture ${slot + 1}>`
  }
  let prompt: string
  switch (intent.kind) {
    case 'character':
      prompt = 'Create one single full-body anime character reference sheet image from <Picture 1>. Use a relaxed front-facing stance with hands clear of the body, a flat solid #EAECEF background and even neutral studio lighting. Keep the same character, face shape, iris color, hairstyle, hair ornament, body proportions, original outfit and anime linework. Preserve a clear readable face. No text, layout panels or props.'
      break
    case 'outfit': {
      const garment = intent.garmentVersionId ? picture(intent.garmentVersionId) : ''
      prompt = [
        'Make one clean full-body costume illustration of the character in <Picture 1>.',
        intent.editPartsOnly
          ? 'Change only the specified garment pieces and keep the rest of the original outfit.'
          : 'Replace the original garments with the requested outfit and remove leftover pieces of the previous costume.',
        identity,
        garment && `Use ${garment} only for the garment cut, materials and construction. Ignore its wearer, face, hair, proportions, pose and background. Keep the character in <Picture 1>.`,
        'Use a relaxed stance with clear hands and show the complete outfit.',
        flatLight,
      ].filter(Boolean).join(' ')
      break
    }
    case 'expression':
      prompt = `Make a head-and-shoulders expression study of <Picture 1>. Change only the expression and gaze as directed. ${identity} Keep the same clothes at the neckline. ${flatLight}`
      break
    case 'pose':
      prompt = `Make a full-body pose study of <Picture 1>. Keep the character's complete outfit, including the fabric pattern, seams, trim and accessories. ${identity} ${flatLight}`
      break
    case 'keyframe': {
      const face = intent.faceVersionId ? picture(intent.faceVersionId) : ''
      const scene = intent.sceneVersionId ? picture(intent.sceneVersionId) : ''
      prompt = [
        'Create one anime film still featuring precisely the character and outfit in <Picture 1>. Preserve the outfit design, colors, materials and trim.',
        identity,
        face && `Use ${face} only to resolve the same character's facial and eye details. Ignore the framing, clothing and background of this face reference.`,
        scene
          ? `Use ${scene} as the empty set. Keep its architecture, light direction and spatial layout. It contributes no people or costume details.`
          : intent.setting,
        'Place the character at a plausible depth in the set. Match the perspective, key light direction, ambient color and contact shadows so the character belongs in the scene. Show one coherent moment with no lettering or collage.',
      ].filter(Boolean).join(' ')
      break
    }
  }
  const choices = intent.choices
  const variations = choices.length ? Array.from({ length: 4 }, (_, i) => choices[i % choices.length]!) : []
  return {
    references,
    prompt,
    count: intent.kind === 'character' ? 1 : 4,
    variations: variations.map(choice => choice.directive).join('\n'),
    variationTitles: variations.map(choice => choice.label),
  }
}
