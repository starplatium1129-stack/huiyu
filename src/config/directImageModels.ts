export const qwenModels = [
  { value: 'qwen-image-2.1-turbo', label: 'Qwen-Image 2.1 Turbo · 8 步' },
  { value: 'qwen-image-2.1', label: 'Qwen-Image 2.1 · 40 步' },
] as const

export const MOSS_MODEL_ID = 'moss-miaomiao-base-v1.1'
export const mossModels = [
  { value: MOSS_MODEL_ID, label: 'MiaoMiao Harem MOSS · BASE v1.1', versionId: '3434952' },
  { value: 'moss-miaomiao-base-v1.0', label: 'MiaoMiao Harem MOSS · BASE v1.0', versionId: '3422319' },
] as const

export const validMossSpectrumFlexWindow = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2

export interface DirectImageModelStatus {
  id: string; available: boolean; unavailableReason: string | null; licenseUrl: string
  mossSpectrum?: boolean; mossFlexWindow?: boolean; mossRemacri?: boolean; mossFp8?: boolean; mossCompile?: boolean
  mossFp16Ready?: boolean; mossInt8Ready?: boolean; mossTextInt8Ready?: boolean
}
