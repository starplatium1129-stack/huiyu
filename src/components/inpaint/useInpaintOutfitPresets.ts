import { computed, ref, watch } from 'vue'
import type { ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'

export interface OutfitPreset {
  id: string
  label: string
  icon: ArchiveIconName
  isNsfw?: boolean
  description: string
  prompt: string
  negativeAdd?: string
}

const OUTFIT_PRESETS: OutfitPreset[] = [
  {
    id: 'bikini_white',
    label: '夏日比基尼',
    icon: 'bikini',
    description: '白色荷叶边系带比基尼泳装，清爽夏日风',
    prompt: 'wearing white frilled bikini, swimsuit, halterneck bikini top, side-tie bikini bottoms, bare navel, smooth skin',
    negativeAdd: 'heavy clothes, long sleeves, jacket, coat',
  },
  {
    id: 'nude_pure',
    label: '私密纯粹形态',
    icon: 'lock',
    isNsfw: true,
    description: '完全剥离衣物，纯粹原生肌肤形态',
    prompt: 'completely naked, full body bare, natural skin, without clothes, bare chest, exposed skin',
    negativeAdd: 'clothes, clothing, shirt, dress, sleeves, bra, panties, fabric, robe, towel',
  },
  {
    id: 'evening_dress',
    label: '纯白晚礼服',
    icon: 'dress',
    description: '优雅露肩丝绸晚礼服，华丽高贵',
    prompt: 'wearing elegant off-shoulder white evening gown, silk dress, sweetheart neckline, delicate lace trim',
    negativeAdd: 'casual clothes, swimsuit, bikini',
  },
  {
    id: 'bunny_girl',
    label: '性感兔女郎',
    icon: 'bunny',
    isNsfw: true,
    description: '漆皮紧身兔女郎服，兔耳与领结',
    prompt: 'wearing glossy black bunny suit, strapless leotard, bunny ears, collar with black bow tie, white wrist cuffs',
    negativeAdd: 'coat, casual shirt, dress',
  },
  {
    id: 'maid_classic',
    label: '古典女仆装',
    icon: 'coffee',
    description: '黑白荷叶边围裙女仆装与女仆发箍',
    prompt: 'wearing classic black and white maid uniform, frilled white apron, maid headdress, puffy short sleeves',
    negativeAdd: 'bikini, modern jacket',
  },
  {
    id: 'casual_trench',
    label: '秋日风衣私服',
    icon: 'coat',
    description: '米色休闲风衣与针织打底，温柔日常',
    prompt: 'wearing stylish beige open trench coat over a soft knit sweater, casual chic outfit',
    negativeAdd: 'swimsuit, bikini, bare skin',
  },
  {
    id: 'sailor_uniform',
    label: '清爽水手服',
    icon: 'school',
    description: '绀色百褶裙日系水手校服',
    prompt: 'wearing navy blue sailor uniform, white collar with red neckerchief, pleated navy skirt',
    negativeAdd: 'swimsuit, bikini, fantasy armor',
  },
  {
    id: 'yukata_floral',
    label: '和风碎花浴衣',
    icon: 'kimono',
    description: '传统日式花纹浴衣与宽腰带',
    prompt: 'wearing traditional floral patterned yukata, colorful kimono dress, decorative wide obi sash, elegant drape',
    negativeAdd: 'bikini, modern clothes',
  },
  {
    id: 'silk_nightgown',
    label: '丝绸吊带睡衣',
    icon: 'ribbon',
    description: '慵懒蕾丝边吊带睡裙',
    prompt: 'wearing silky lace-trimmed camisole nightgown, thin shoulder straps, delicate satin sleepwear',
    negativeAdd: 'heavy jacket, school uniform',
  },
]

export interface InpaintOutfitPresetsDeps {
  /** 弹窗开关（每次打开重置角色 LoRA 选择为 auto）。 */
  open: () => boolean
}

/**
 * 局部换装弹窗「服装预设 + 换装参数」（2026-08-22 自 AnimaInpaintModal 下沉）。
 *
 * 九套服装预设（含 LoRA 正/负词与 NSFW 标记）+ 自定义描述、CLIPSeg
 * 语义遮罩 prompt 与灵敏度、denoise/扩边等提交参数。预设切换联动
 * 参数（纯粹形态 = 高 denoise 大扩边）；所有预设均可选择。
 */
export function useInpaintOutfitPresets(deps: InpaintOutfitPresetsDeps) {
  const selectedPresetId = ref<string>('bikini_white')
  const customPrompt = ref<string>('')
  const maskPrompt = ref<string>('clothing | clothes | outfit | dress | shirt | sweater | blouse | jacket | cardigan | coat | top | uniform | skirt | pants | shorts | sleeves | collar | costume | garment | fabric | bra | panties | underwear | swimsuit | bikini')
  // CLIPSeg 识别灵敏度：阈值越低识别区域越大。实测 0.20 会把身体/背景大片拉进
  // 重绘区（denoise 高时构图漂移），0.45 起才聚焦服装主体（2026-08-21 实机验证）。
  const maskThreshold = ref<number>(0.45)
  const denoisingStrength = ref<number>(0.85)
  const growMaskBy = ref<number>(8)
  const preserveSeed = ref<boolean>(true)
  const characterMode = ref<'auto' | 'nene' | 'natsume' | 'none'>('auto')

  const currentPreset = computed(() => OUTFIT_PRESETS.find(p => p.id === selectedPresetId.value))

  watch(selectedPresetId, (newId) => {
    if (newId !== 'custom') {
      const preset = OUTFIT_PRESETS.find(p => p.id === newId)
      if (preset) {
        customPrompt.value = preset.prompt
        if (preset.id === 'nude_pure') {
          denoisingStrength.value = 0.95
          growMaskBy.value = 16
        } else {
          denoisingStrength.value = 0.85
          growMaskBy.value = 8
        }
      }
    }
  }, { immediate: true })

  watch(deps.open, (isOpen) => {
    if (isOpen) characterMode.value = 'auto'
  })

  return {
    presets: OUTFIT_PRESETS,
    currentPreset,
    selectedPresetId,
    customPrompt,
    maskPrompt,
    maskThreshold,
    denoisingStrength,
    growMaskBy,
    preserveSeed,
    characterMode,
  }
}
