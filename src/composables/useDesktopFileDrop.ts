import { computed, shallowRef } from 'vue'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

export type DesktopFileAction = 'card' | 'interrogate' | 'edit-image'
const request = shallowRef<{ action: DesktopFileAction; files: File[]; authority: string } | null>(null)
export const pendingDesktopFileAction = computed(() => request.value?.action)
let expiry: number | undefined

export function discardDesktopFiles() {
  window.clearTimeout(expiry)
  request.value = null
}

export function queueDesktopFiles(action: DesktopFileAction, files: File[], onExpire: () => void) {
  discardDesktopFiles()
  request.value = { action, files, authority: runtimeResourceIdentity() }
  expiry = window.setTimeout(() => { discardDesktopFiles(); onExpire() }, 20_000)
}

export function takeDesktopFiles(action: DesktopFileAction): File[] {
  const current = request.value
  if (current?.action !== action) return []
  discardDesktopFiles()
  return current.authority === runtimeResourceIdentity() ? current.files : []
}

const MIB = 1024 * 1024
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10]

async function isCardPng(file: File): Promise<boolean> {
  if (file.size > 16 * MIB || file.size < pngSignature.length + 12) return false
  const data = new Uint8Array(await file.arrayBuffer())
  if (pngSignature.some((value, index) => data[index] !== value)) return false
  const view = new DataView(data.buffer)
  for (let offset = 8, count = 0; offset + 12 <= data.length && count < 4096; count++) {
    const length = view.getUint32(offset)
    const next = offset + length + 12
    if (next > data.length) return false
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8))
    if (type === 'IEND') return false
    if (['tEXt', 'zTXt', 'iTXt'].includes(type) && length > 5) {
      const prefix = String.fromCharCode(...data.subarray(offset + 8, offset + 14))
      if (prefix === 'chara\0' || prefix.startsWith('ccv3\0')) return true
    }
    offset = next
  }
  return false
}

export async function desktopFileKind(file: File): Promise<'card' | 'image' | 'unknown'> {
  if (!file.size) return 'unknown'
  if (/\.json$/i.test(file.name)) {
    if (file.size > MIB) return 'unknown'
    try {
      const value: unknown = JSON.parse(await file.text())
      if (value && typeof value === 'object' && 'spec' in value
        && (value.spec === 'chara_card_v2' || value.spec === 'chara_card_v3')) return 'card'
    } catch { /* The selected JSON does not contain a character card. */ }
    return 'unknown'
  }
  if (/\.png$/i.test(file.name) && await isCardPng(file)) return 'card'
  if (/\.(png|jpe?g|webp)$/i.test(file.name) && file.size <= 16 * MIB) return 'image'
  return 'unknown'
}
