import { computed, type Ref } from 'vue'
import { resolveCompanionAvatar } from '@/utils/companionRegistry'
import { profileExpressionOptions } from '@/live2d/companionEmotion'

export interface CharacterPetControls {
  ready: boolean
  motions: { id: string; label: string }[]
  expressions: { id: string; label: string }[]
  hint: string
}

interface PetRuntime {
  ready: Ref<boolean>
  enabled: Ref<boolean>
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
      expressions: [...(config?.avatar.expressions || []).map(({ id, label }) => ({ id, label })), ...profileExpressionOptions(config?.profile)],
      hint: !runtime.ready.value || runtime.loadedCharacter.value !== character()
        ? runtime.enabled.value ? '动态立绘尚未就绪，加载完成后再试；加载失败可在设置中重试。' : '先在设置中加载动态立绘，再试试表情和动作。'
        : runtime.interactionHint.value,
    }
  })
  function playPetMotion(id: string) {
    runtime.playPetMotion(id)
  }
  async function setPetExpression(id: string) {
    if (!petControls.value.ready || (id && !petControls.value.expressions.some(item => item.id === id))) return false
    return runtime.setExpression(id)
  }
  return { petControls, playPetMotion, setPetExpression }
}
