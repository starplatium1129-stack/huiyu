import { runtimeFetch } from '../platform/runtimeUrl.ts'
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'
/**
 * 桌宠屏幕感知与多模态视觉工具集
 *
 * 支持：
 * 1. 原生 getDisplayMedia 屏幕截帧
 * 2. 图片 Blob / File 转换为 DataURL
 * 3. 角色专属看屏锐评 Prompt 生成
 */

/** 根据角色生成看屏锐评的 Prompt */
export function getCharacterInspectionPrompt(character: string): string {
  if (character === 'natsume') {
    return '（这是我当前的屏幕截图）夏目，帮我看看我现在的屏幕，用你的毒舌或傲娇口吻犀利锐评一下吧～'
  }
  if (character === 'nene') {
    return '（这是我当前的屏幕截图）宁宁学姐，快来看看我现在的屏幕，觉得怎么样呢？'
  }
  return '（这是我当前的屏幕截图）帮我看看我现在的屏幕画面，并给出你的评价与互动～'
}

/**
 * 抓取当前屏幕的一帧画面并转为压缩后的 DataURL (1080p 紧凑格式，防传输超限)
 */
export async function captureScreenFrame(signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted()
  if (getDesktopCapabilities()) {
    const res = await runtimeFetch('/api/desktop-tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'capture_screen', args: {} }),
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
    })
    const data = await res.json()
    if (!res.ok || !data.ok || typeof data.imageDataUrl !== 'string' || !/^data:image\/jpeg;base64,/.test(data.imageDataUrl)) {
      throw new Error(typeof data.output === 'string' ? data.output : '没有截取到屏幕，请重试。')
    }
    signal?.throwIfAborted()
    const frame = await fetch(data.imageDataUrl).then(response => response.blob())
    return imageForInspection(frame, signal)
  }
  // Browser sharing starts in the original click, before any network await.
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('当前浏览器不支持分享屏幕，请使用桌面客户端或支持分享的浏览器。')
  }
  let stream: MediaStream | null = null
  const deadline = AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])])
  const stopTracks = () => stream?.getTracks().forEach(track => track.stop())
  let rejectInterrupted = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterrupted = () => reject(deadline.reason)
    deadline.addEventListener('abort', rejectInterrupted, { once: true })
  })
  let video: HTMLVideoElement | null = null
  try {
    const acquisition = navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 5, max: 10 },
      },
      audio: false,
    })
    void acquisition.then(value => { if (deadline.aborted) value.getTracks().forEach(track => track.stop()) }, () => {})
    stream = await Promise.race([acquisition, interrupted])
    deadline.throwIfAborted()
    deadline.addEventListener('abort', stopTracks, { once: true })
    const videoTrack = stream.getVideoTracks()[0]
    if (!videoTrack) throw new Error('没有获取到屏幕画面。')

    video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    await Promise.race([video.play(), interrupted])
    deadline.throwIfAborted()

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 1280
    canvas.height = video.videoHeight || 720
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法读取屏幕画面，请重试。')

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82)

    return dataUrl
  } finally {
    deadline.removeEventListener('abort', stopTracks)
    deadline.removeEventListener('abort', rejectInterrupted)
    stopTracks()
    if (video) { video.pause(); video.srcObject = null }
  }
}

/** Bound the vision payload while leaving clipboard/gallery originals intact. */
export async function imageForInspection(blob: Blob, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const bitmap = await createImageBitmap(blob)
  try {
    signal?.throwIfAborted()
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法读取图片，请重新复制后重试。')
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', .85)
  } finally { bitmap.close() }
}

