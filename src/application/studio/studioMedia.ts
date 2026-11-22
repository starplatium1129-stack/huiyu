import type { StudioAssetKind } from '../../../types/studioProject'
import { imageFormat } from '../../utils/imageFormat'
import { studioMediaMatches } from './projectRepository'

export async function normalizeStudioMedia(blob: Blob, kind: StudioAssetKind): Promise<Blob> {
  const header = await blob.slice(0, 4096).arrayBuffer()
  let mime: string
  if (kind === 'audio' || kind === 'clip') {
    const bytes = new Uint8Array(header), text = new TextDecoder('latin1').decode(bytes)
    if (text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE') mime = 'audio/wav'
    else if (text.slice(4, 8) === 'ftyp' && ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].includes(text.slice(8, 12))) mime = 'video/mp4'
    else if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 && text.includes('webm')) mime = 'video/webm'
    else throw new Error('无法识别音视频原件')
  } else mime = imageFormat(header).mime
  if (!studioMediaMatches(kind, mime)) throw new Error('素材种类与原件格式不一致')
  return mime === blob.type ? blob : blob.slice(0, blob.size, mime)
}
