/** Mono PCM16 WAV encoding shared by microphone input and synthesized speech. */
export function createPcm16MonoWavHeader(dataSize: number, sampleRate: number): ArrayBuffer {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataSize, true)
  return header
}

/** 将单声道 Float32 采样编码为标准 WAV（PCM16）。 */
export function encodeWav16k(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataSize = samples.length * 2
  const bytes = new Uint8Array(44 + dataSize)
  bytes.set(new Uint8Array(createPcm16MonoWavHeader(dataSize, sampleRate)))
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return bytes
}

/** 线性插值重采样到 16kHz。 */
export function resampleTo16k(input: Float32Array, srcRate: number): Float32Array {
  if (srcRate === 16_000) return input
  if (srcRate <= 0 || !Number.isFinite(srcRate)) return input
  const ratio = srcRate / 16_000
  const out = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
  for (let i = 0; i < out.length; i += 1) {
    const pos = i * ratio
    const i0 = Math.min(input.length - 1, Math.floor(pos))
    const i1 = Math.min(input.length - 1, i0 + 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}
