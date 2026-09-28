import { afterEach, describe, expect, it, vi } from 'vitest'
import { createParticleGpuRenderer } from './particleGpu'
import type { ParticleBodyPoint, ParticleBodyStyle } from './particleBody'

function harness() {
  const calls = new Map<string, ReturnType<typeof vi.fn>>()
  const values = new Map<string, number>()
  const uploads: number[][] = []
  const gl = new Proxy({}, {
    get(_, key: string) {
      if (/^[A-Z_0-9]+$/.test(key)) {
        if (!values.has(key)) values.set(key, values.size + 1)
        return values.get(key)
      }
      if (!calls.has(key)) calls.set(key, vi.fn((...args: unknown[]) => {
        if (key === 'getShaderParameter' || key === 'getProgramParameter') return true
        if (key === 'isContextLost') return false
        if (key === 'getUniformLocation') return args[1]
        if (key === 'checkFramebufferStatus') return gl.FRAMEBUFFER_COMPLETE
        if (key === 'bufferSubData') {
          const data = args[2] as Float32Array
          const start = (args[3] as number) || 0
          uploads.push(Array.from(data.slice(start, start + ((args[4] as number) || data.length))))
        }
        if (key.startsWith('create')) return {}
        return null
      }))
      return calls.get(key)
    },
  }) as WebGL2RenderingContext
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(gl)
  const context = { save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D
  const renderer = createParticleGpuRenderer()!
  return { renderer, gl, calls, uploads, context }
}
const point = (paint: number, x = 20): ParticleBodyPoint => ({ x, y: 20, prevX: x - 2, prevY: 20, targetX: x, targetY: 20, tone: 0, paint, size: 1 })
const style = (darkTheme = false): ParticleBodyStyle => ({
  paints: ['#ffffff', '#eeeeee'], radii: [1, 2], darkTheme, energyScale: 1,
  surface: '#ffffff', outline: '#111111', palette: { primary: '#ffffff', secondary: '#eeeeee', accent: '#aaaaaa' },
})
afterEach(() => vi.restoreAllMocks())

describe('particle GPU resource reuse', () => {
  it.each([false, true])('retains all moving particle passes and reuses frame storage, dark=%s', dark => {
    const { renderer, gl, context, uploads, calls } = harness()
    const points = [point(1), point(0, 40)]
    const frameStyle = style(dark)
    for (let frame = 0; frame < 60; frame++) {
      points[0].x++
      expect(renderer.draw(context, 100, 100, 2, points, frameStyle)).toBe(true)
    }
    const passes = dark ? 4 : 8
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(passes * 60)
    expect(gl.drawArrays).toHaveBeenCalledTimes(passes * 60)
    expect(gl.uniform2f).toHaveBeenCalledTimes(2 * 60)
    expect(gl.uniform1f).toHaveBeenCalledTimes(60)
    expect(gl.bufferData).toHaveBeenCalledTimes(1)
    expect(gl.texImage2D).toHaveBeenCalledTimes(1)
    expect(gl.bufferSubData).toHaveBeenCalledTimes(60)
    const writes = calls.get('bufferSubData')!.mock.calls
    expect(writes.every(call => call[2] === writes[0][2])).toBe(true)
    expect(uploads.every(data => data.length === 10)).toBe(true)
    expect(uploads[0][0]).toBe(40) // packed by paint, not source order
    expect(uploads[59][5]).toBe(80)
    expect(context.drawImage).toHaveBeenCalledTimes(60)
    renderer.release()
  })

  it('does not upload stale capacity or keep stale tail bounds after points stop', () => {
    const { renderer, gl, context, uploads } = harness()
    renderer.draw(context, 100, 100, 1, [point(0), point(1)], style(true))
    const stopped = point(0), smaller = [stopped]
    renderer.draw(context, 100, 100, 1, smaller, style(true))
    stopped.prevX = stopped.x
    vi.mocked(gl.drawArraysInstanced).mockClear()
    renderer.draw(context, 100, 100, 1, smaller, style(true))
    expect(uploads[1]).toHaveLength(5)
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(1)
    renderer.draw(context, 100, 100, 1, [], style(true))
    expect(gl.bufferSubData).toHaveBeenCalledTimes(3)
    renderer.release()
  })

  it('updates cached paint and outline colors after a live theme change', () => {
    const { renderer, gl, context } = harness()
    const points = [point(0)], frameStyle = style()
    renderer.draw(context, 100, 100, 1, points, frameStyle)
    frameStyle.outline = '#223344'; frameStyle.paints![0] = '#dddddd'
    vi.mocked(gl.uniform4f).mockClear()
    renderer.draw(context, 100, 100, 1, points, frameStyle)
    expect(gl.uniform4f).toHaveBeenCalledWith('paint', 0x22 / 255, 0x33 / 255, 0x44 / 255, .38)
    expect(gl.uniform4f).toHaveBeenCalledWith('paint', 0xdd / 255, 0xdd / 255, 0xdd / 255, 1)
    renderer.release()
  })

  it('resizes only when needed and releases every GPU resource once', () => {
    const { renderer, gl, context } = harness()
    const points = [point(0)]
    renderer.draw(context, 100, 100, 1, points, style())
    renderer.draw(context, 200, 100, 2, points, style())
    expect(gl.texImage2D).toHaveBeenCalledTimes(2)
    renderer.release(); renderer.release()
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1)
    expect(gl.deleteTexture).toHaveBeenCalledTimes(1)
    expect(gl.deleteFramebuffer).toHaveBeenCalledTimes(1)
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(2)
    expect(gl.deleteProgram).toHaveBeenCalledTimes(2)
    expect(renderer.draw(context, 100, 100, 1, points, style())).toBe(false)
  })
})
