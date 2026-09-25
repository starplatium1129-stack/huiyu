import type { StudioSelectOption } from '@/components/ui/StudioSelect.vue'

/** 镜头级参数与剧本档位的选项：原先内联在 <option> 里，抽出来让模板保持单行。 */
export const shotSizeOptions: StudioSelectOption[] = [
  { value: '', label: '默认' },
  { value: 'wide', label: '全景' },
  { value: 'medium', label: '中景' },
  { value: 'closeup', label: '特写' },
]

/** 时长是数字值：shot.duration 为 number，保持类型不要字符串化。 */
export const durationOptions: StudioSelectOption[] = [
  { value: 3, label: '3 秒' },
  { value: 5, label: '5 秒（推荐）' },
  { value: 10, label: '10 秒 · 长镜' },
  { value: 15, label: '15 秒 · 长镜' },
]

export const scriptCountOptions: StudioSelectOption[] = [
  { value: '', label: '自动' },
  { value: 8, label: '8 镜' },
  { value: 10, label: '10 镜' },
  { value: 12, label: '12 镜' },
]

export const scriptTotalOptions: StudioSelectOption[] = [
  { value: '', label: '自动' },
  { value: 40, label: '约 40s' },
  { value: 60, label: '约 60s' },
  { value: 90, label: '约 90s' },
]
