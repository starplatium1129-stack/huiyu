import { computed, type Ref } from 'vue'
import { resolveCompanionAvatar } from '@/utils/companionRegistry'

export interface CharacterPetControls {
  ready: boolean
  motions: { id: string; label: string }[]
  expressions: { id: string; label: string }[]
  hint: string
}

interface PetRuntime {
  ready: Ref<boolean>
  loadedCharacter: Ref<string>
  interactionHint: Ref<string>
  playPetMotion: (id: string) => void
  setExpression: (id: string) => Promise<boolean>
}

/** Menus expose only the active registered model's authored capabilities. */
export function useCharacterPetControls(character: () => string, runtime: PetRuntime) {
  const petControls = computed<CharacterPetControls>(() => {
    const config = resolveCompanionAvatar(character())
    return {
      ready: runtime.ready.value && runtime.loadedCharacter.value === character(),
      motions: Object.entries(config?.profile?.interactions || {}).map(([id, motion]) => ({ id, label: motion.hint || motion.group })),
      expressions: (config?.avatar.expressions || []).map(({ id, label }) => ({ id, label })),
      hint: runtime.interactionHint.value,
    }
  })
  function playPetMotion(id: string) {
    if (petControls.value.ready && petControls.value.motions.some(item => item.id === id)) runtime.playPetMotion(id)
  }
  async function setPetExpression(id: string) {
    if (!petControls.value.ready || (id && !petControls.value.expressions.some(item => item.id === id))) return false
    return runtime.setExpression(id)
  }
  return { petControls, playPetMotion, setPetExpression }
}
