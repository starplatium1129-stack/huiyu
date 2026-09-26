import { runtimeFetch } from '../platform/runtimeUrl.ts'
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

/** 将 Blob / File 转换为 Base64 DataURL */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/**
 * 抓取当前屏幕的一帧画面并转为压缩后的 DataURL (1080p 紧凑格式，防传输超限)
 */
export async function captureScreenFrame(): Promise<string | null> {
  // 1. 优先尝试本地桌面网关的原生截屏（在桌面客户端及本机环境下免授权弹窗、毫秒级截取）
  try {
    const res = await runtimeFetch('/api/desktop-tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'capture_screen', args: {} }),
    })
    if (res.ok) {
      const data = await res.json()
      if (data.ok && data.imageDataUrl) {
        return data.imageDataUrl
      }
    }
  } catch {
    // 原生截屏失败时降级到浏览器标准 getDisplayMedia
  }

  // 2. 浏览器标准 getDisplayMedia 兜底
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
    return null
  }

  let stream: MediaStream | null = null
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 5, max: 10 },
      },
      audio: false,
    })

    const videoTrack = stream.getVideoTracks()[0]
    if (!videoTrack) return null

    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    await video.play()

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 1280
    canvas.height = video.videoHeight || 720
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82)

    return dataUrl
  } catch (err) {
    // 用户取消分享屏幕或权限拒绝
    return null
  } finally {
    if (stream) {
      stream.getTracks().forEach(track => track.stop())
    }
  }
}

