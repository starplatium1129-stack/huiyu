import { computed, ref, type Ref } from 'vue'
import type { H3Decoder, H3StepChoice, H3Steps, VideoAttention, VideoModelStatus } from '@/api/videoApi'

/** Keep the user's choice separate from the default resolved for this machine. */
export function useNativeH3Recipe(model: Readonly<Ref<VideoModelStatus | null>>, attention?: Ref<VideoAttention>) {
  const choice = ref<H3StepChoice>('auto')
  const lightVae = ref(true)
  const fourOnly = computed(() => attention?.value === 'h3-sla' || attention?.value === 'h3-fused')
  const defaultSteps = computed<H3Steps>(() => model.value?.h3Dwd && !fourOnly.value ? 2 : model.value?.turboSteps?.[0] ?? 4)
  const steps = computed(() => choice.value === 'auto' ? defaultSteps.value : choice.value)
  const issue = computed(() => {
    if (model.value?.id !== 'minimax-h3') return ''
    if (steps.value === 2 && !model.value.h3Dwd) return '2 步 pi-H3 DWD 权重尚未就绪，请导入权重或选择 Turbo 配方。'
    if (fourOnly.value && steps.value !== 4) return '当前稀疏注意力需要 4 步 Turbo，请切换采样配方或注意力。'
    if (attention?.value.startsWith('h3-') && !model.value.attentionModes?.includes(attention.value))
      return '草稿所选的 H3 注意力尚未就绪，请重新选择注意力。'
    if (steps.value !== 2 && model.value.turboSteps && !model.value.turboSteps.includes(steps.value))
      return `${steps.value} 步 Turbo 权重尚未就绪，请选择已安装的配方。`
    return ''
  })
  const input = computed<{ steps?: H3Steps; h3Decoder?: H3Decoder }>(() => {
    if (model.value?.id !== 'minimax-h3') return {}
    if (choice.value === 'auto' && !fourOnly.value) return {}
    if (steps.value === 2) return { steps: 2, h3Decoder: 'dwd' }
    if (!model.value.turboSteps) return {}
    return { steps: steps.value, h3Decoder: lightVae.value && model.value.h3LightVae ? 'lightvae' : 'original' }
  })
  return { choice, lightVae, steps, defaultSteps, issue, input }
}
