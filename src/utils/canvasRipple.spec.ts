import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startCanvasRipple } from './canvasRipple'

const frames = new Map<number, FrameRequestCallback>()
const canvases: HTMLCanvasElement[] = []
let stop: (() => void) | undefined
const gl = {
  createProgram: vi.fn(() => ({})), createBuffer: vi.fn(() => ({})), createTexture: vi.fn(() => ({})), createShader: vi.fn(() => ({})),
  shaderSource: vi.fn(), compileShader: vi.fn(), getShaderParameter: vi.fn(() => true), attachShader: vi.fn(),
  linkProgram: vi.fn(), getProgramParameter: vi.fn(() => true), useProgram: vi.fn(), bindBuffer: vi.fn(), bufferData: vi.fn(),
  getAttribLocation: vi.fn(() => 0), enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(), bindTexture: vi.fn(),
  pixelStorei: vi.fn(), texParameteri: vi.fn(), texImage2D: vi.fn(), getError: vi.fn(() => 0), NO_ERROR: 0,
  viewport: vi.fn(), uniform2f: vi.fn(), uniform1i: vi.fn(), uniform1f: vi.fn(), getUniformLocation: vi.fn(() => ({})), drawArrays: vi.fn(),
  deleteTexture: vi.fn(), deleteBuffer: vi.fn(), deleteProgram: vi.fn(), deleteShader: vi.fn(),
  getExtension: vi.fn(() => ({ loseContext })),
}
const loseContext = vi.fn()
const drawImage = vi.fn()
function fixture() {
  const image = document.createElement('img'), host = document.createElement('div')
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 3840 }, naturalHeight: { value: 2160 } })
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 3840, 2160))
  host.appendChild(image)
  return { image, host }
}
function tick(now: number) { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now)) }
beforeEach(() => {
  vi.clearAllMocks()
  stop = undefined
  let id = 0
  vi.stubGlobal('devicePixelRatio', 3)
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++id, fn); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.spyOn(performance, 'now').mockReturnValue(0)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, type: string) {
    canvases.push(this)
    return (type === 'webgl' ? gl : { drawImage }) as unknown as RenderingContext
  })
})
afterEach(() => { stop?.(); canvases.length = 0; frames.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('caps texture and backing at high DPI, throttles paints, and releases all GPU allocations', () => {
  const { image, host } = fixture()
  const effect = startCanvasRipple(image, host, 520)!
  stop = effect.stop
  expect(effect.canvas.width * effect.canvas.height).toBeLessThanOrEqual(600_000)
  expect(Math.max(effect.canvas.width, effect.canvas.height)).toBeLessThanOrEqual(960)
  const [, , , w, h] = drawImage.mock.calls[0]
  expect(w * h).toBeLessThanOrEqual(600_000)
  expect(canvases[1].width).toBe(0)
  expect(gl.drawArrays).toHaveBeenCalledOnce()
  tick(16)
  expect(gl.drawArrays).toHaveBeenCalledOnce()
  tick(40)
  expect(gl.drawArrays).toHaveBeenCalledTimes(2)
  tick(520)
  expect(host.querySelector('canvas')).toBeNull()
  expect(canvases.every(canvas => canvas.width === 0)).toBe(true)
  expect(gl.deleteTexture).toHaveBeenCalledOnce()
  expect(gl.deleteBuffer).toHaveBeenCalledOnce()
  expect(gl.deleteProgram).toHaveBeenCalledOnce()
  expect(gl.deleteShader).toHaveBeenCalledTimes(2)
  expect(loseContext).toHaveBeenCalledOnce()
  expect(frames.size).toBe(0)
  expect(image.style.transform).toBe('')
  expect(image.style.opacity).toBe('')
})

it.each(['cancel', 'context lost', 'slow frames', 'hidden'])('releases the layer under %s and rejects stale frames', reason => {
  const { image, host } = fixture()
  const effect = startCanvasRipple(image, host, 520)!
  stop = effect.stop
  const stale = [...frames.values()][0]
  if (reason === 'cancel') { stop(); stop() }
  if (reason === 'context lost') effect.canvas.dispatchEvent(new Event('webglcontextlost'))
  if (reason === 'slow frames') { tick(100); tick(200) }
  if (reason === 'hidden') { vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); tick(50) }
  const paints = gl.drawArrays.mock.calls.length
  stale(210)
  expect(gl.drawArrays).toHaveBeenCalledTimes(paints)
  expect(frames.size).toBe(0)
  expect(host.querySelector('canvas')).toBeNull()
  expect(loseContext).toHaveBeenCalledOnce()
})

it.each(['CORS', 'no WebGL', 'shader compile'])('falls back cleanly on %s failure', reason => {
  const { image, host } = fixture()
  if (reason === 'CORS') gl.texImage2D.mockImplementationOnce(() => { throw new DOMException('Tainted canvas', 'SecurityError') })
  if (reason === 'no WebGL') vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  if (reason === 'shader compile') gl.getShaderParameter.mockReturnValueOnce(false)
  expect(startCanvasRipple(image, host, 520)).toBeNull()
  expect(host.querySelector('canvas')).toBeNull()
  expect(frames.size).toBe(0)
  expect(canvases.every(canvas => canvas.width === 0)).toBe(true)
})
