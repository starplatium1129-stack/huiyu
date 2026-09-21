import { afterEach, expect, it, vi } from 'vitest'
import { blobThumbDataUrl } from './imageThumb'

afterEach(() => { vi.unstubAllGlobals() })
const imageBlob = () => new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII='), value => value.charCodeAt(0))], { type: 'image/png' })

function fallbackImage(fail = false) {
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumbnail-test')
  vi.stubGlobal('Image', class {
    naturalWidth = 1000
    naturalHeight = 1000
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => fail ? this.onerror?.() : this.onload?.())
    }
  })
  return revoke
}

it('画布编码失败时关闭位图，兜底失败也结束请求并释放 URL', async () => {
  const close = vi.fn()
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1000, height: 1000, close }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => { throw new Error('encoding failed') })
  const revoke = fallbackImage()
  await expect(blobThumbDataUrl(imageBlob())).resolves.toBe('')
  expect(close).toHaveBeenCalledTimes(1)
  expect(revoke).toHaveBeenCalledWith('blob:thumbnail-test')
})

it('位图成功生成缩略图后立即释放解码资源', async () => {
  const close = vi.fn()
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1000, height: 1000, close }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,test')
  await expect(blobThumbDataUrl(imageBlob())).resolves.toBe('data:image/jpeg;base64,test')
  expect(close).toHaveBeenCalledTimes(1)
})

it('图片解码失败时返回空结果并释放 URL', async () => {
  vi.stubGlobal('createImageBitmap', undefined)
  const revoke = fallbackImage(true)
  await expect(blobThumbDataUrl(imageBlob())).resolves.toBe('')
  expect(revoke).toHaveBeenCalledWith('blob:thumbnail-test')
})
