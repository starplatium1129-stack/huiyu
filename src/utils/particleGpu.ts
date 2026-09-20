import { particleNeedsOutline } from './particlePortrait'
import type { ParticleBodyPoint, ParticleBodyStyle } from './particleBody'
import { LIGHT_PARTICLE_SCALE, PARTICLE_EDGE_SCALE, LIGHT_PARTICLE_EDGE_ALPHA, LIGHT_PARTICLE_TAIL_ALPHA } from './particleBody'

const vertex = `#version 300 es
precision highp float;
layout(location=0) in vec4 position;
layout(location=1) in float radius;
uniform vec2 resolution;
uniform float dpr;
uniform int kind;
out vec2 local;
flat out vec2 segment;
flat out float size;
void main() {
  vec2 a = position.xy;
  vec2 b = kind == 2 || kind == 3 ? position.zw : a;
  size = kind == 1 ? radius * ${PARTICLE_EDGE_SCALE} : kind == 2 ? 1.2 : kind == 3 ? .7 : radius;
  if ((kind == 2 || kind == 3) && dot(a-b,a-b) <= .12) size = -1.;
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 p = mix(min(a,b)-size-1./dpr, max(a,b)+size+1./dpr, corner);
  local = p-a;
  segment = b-a;
  gl_Position = vec4(p/resolution*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);
}`
const fragment = `#version 300 es
precision highp float;
in vec2 local;
flat in vec2 segment;
flat in float size;
uniform float dpr;
out vec4 color;
void main() {
  if (size < 0.) discard;
  // Pixel-area coverage matters for the tiny dots at DPR 1. A center-distance
  // ramp over-brightens their curved edges; integrate sixteen subpixel samples.
  float coverage = 0.;
  for (int y=0; y<4; y++) for (int x=0; x<4; x++) {
    vec2 p = local + (vec2(float(x),float(y))*.25-.375)/dpr;
    float t = clamp(dot(p,segment)/max(dot(segment,segment),.000001),0.,1.);
    coverage += clamp(.5-(length(p-segment*t)-size)*dpr*4.,0.,1.)/16.;
  }
  color = vec4(coverage);
}`
const compositeVertex = `#version 300 es
precision highp float;
uniform vec4 bounds;
uniform vec2 resolution;
out vec2 uv;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1),float(gl_VertexID >> 1));
  uv = mix(bounds.xy,bounds.zw,corner)/resolution;
  gl_Position = vec4(uv*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);
}`
const compositeFragment = `#version 300 es
precision highp float;
uniform sampler2D mask;
uniform vec4 paint;
in vec2 uv;
out vec4 color;
void main() {
  float alpha = texture(mask,vec2(uv.x,1.-uv.y)).r * paint.a;
  color = vec4(paint.rgb*alpha,alpha);
}`

function program(gl: WebGL2RenderingContext, vert: string, frag: string) {
  const shaders: WebGLShader[] = []
  const result = gl.createProgram()!
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, vert], [gl.FRAGMENT_SHADER, frag]] as const) {
      const shader = gl.createShader(type)!
      shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Particle shader failed')
      gl.attachShader(result, shader)
    }
    gl.linkProgram(result)
    if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result) || 'Particle program failed')
    return result
  } catch (error) { gl.deleteProgram(result); throw error }
  finally { shaders.forEach(shader => gl.deleteShader(shader)) }
}

type Bounds = [number, number, number, number]
const emptyBounds = (): Bounds => [Infinity, Infinity, -Infinity, -Infinity]
function include(bounds: Bounds, x: number, y: number, margin: number) {
  bounds[0] = Math.min(bounds[0], x - margin); bounds[1] = Math.min(bounds[1], y - margin)
  bounds[2] = Math.max(bounds[2], x + margin); bounds[3] = Math.max(bounds[3], y + margin)
}
const rgb = (color: string) => [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255)

/** Instanced circle/capsule masks keep each palette pass a union, as in Path2D.
 * No per-particle Canvas paths, readbacks, frame caps or point-count reduction. */
export function createParticleGpuRenderer() {
  const canvas = document.createElement('canvas')
  let lost = false, disposed = false
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); lost = true })
  // The owner can keep its Canvas fallback for the rest of this component's life.
  let gl: WebGL2RenderingContext | null
  try { gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false }) }
  catch { return null }
  if (!gl) return null
  let maskProgram: WebGLProgram, compositeProgram: WebGLProgram
  try { maskProgram = program(gl, vertex, fragment); compositeProgram = program(gl, compositeVertex, compositeFragment) }
  catch { gl.getExtension('WEBGL_lose_context')?.loseContext(); return null }
  const buffer = gl.createBuffer()!, texture = gl.createTexture()!, framebuffer = gl.createFramebuffer()!
  const vao = gl.createVertexArray()!, compositeVao = gl.createVertexArray()!
  const uniform = (p: WebGLProgram, name: string) => gl.getUniformLocation(p, name)
  const maskResolution = uniform(maskProgram, 'resolution'), maskDpr = uniform(maskProgram, 'dpr'), kind = uniform(maskProgram, 'kind')
  const compositeResolution = uniform(compositeProgram, 'resolution'), boundsUniform = uniform(compositeProgram, 'bounds'), paintUniform = uniform(compositeProgram, 'paint')
  gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.enableVertexAttribArray(0); gl.enableVertexAttribArray(1)
  gl.vertexAttribDivisor(0, 1); gl.vertexAttribDivisor(1, 1)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  let data = new Float32Array(0), source: readonly ParticleBodyPoint[] | null = null
  let groups: number[][] = [], colorKey = '', colors: number[][] = [], outlines: boolean[] = []
  let textureWidth = 0, textureHeight = 0

  return {
    draw(context: CanvasRenderingContext2D, width: number, height: number, dpr: number,
      points: readonly ParticleBodyPoint[], style: ParticleBodyStyle): boolean {
      if (lost || disposed || gl.isContextLost() || !style.paints?.length) return false
      if (!style.paints.every(color => /^#[\da-f]{6}$/i.test(color)) || !/^#[\da-f]{6}$/i.test(style.outline)) return false
      const paints = style.paints
      const key = `${paints.join(',')}|${style.surface}|${style.darkTheme}`
      if (key !== colorKey) {
        colorKey = key; colors = paints.map(rgb)
        outlines = paints.map(color => !style.darkTheme && particleNeedsOutline(color, style.surface))
      }
      if (source !== points || groups.length !== paints.length) {
        source = points; groups = paints.map(() => [])
        points.forEach((point, index) => groups[Math.min(paints.length - 1, Math.max(0, point.paint))].push(index))
      }
      const w = Math.round(width * dpr), h = Math.round(height * dpr)
      if (textureWidth !== w || textureHeight !== h) {
        canvas.width = w; canvas.height = h; textureWidth = w; textureHeight = h
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null)
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { lost = true; return false }
      }
      if (data.length < points.length * 5) {
        data = new Float32Array(points.length * 5)
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW)
      }
      const heads = groups.map(emptyBounds), tails = groups.map(emptyBounds), starts: number[] = []
      let cursor = 0
      groups.forEach((indices, group) => {
        starts.push(cursor / 5)
        const radius = (style.radii[group] || 1) * (style.darkTheme ? 1 : LIGHT_PARTICLE_SCALE) * style.energyScale
        for (const index of indices) {
          const p = points[index], r = radius * p.size
          data[cursor++] = p.x; data[cursor++] = p.y; data[cursor++] = p.prevX; data[cursor++] = p.prevY; data[cursor++] = r
          include(heads[group], p.x, p.y, r * PARTICLE_EDGE_SCALE + 1 / dpr)
          if ((p.x - p.prevX) ** 2 + (p.y - p.prevY) ** 2 > .12) {
            include(tails[group], p.x, p.y, 1.2 + 1 / dpr); include(tails[group], p.prevX, p.prevY, 1.2 + 1 / dpr)
          }
        }
      })
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, cursor))
      gl.viewport(0, 0, w, h); gl.disable(gl.SCISSOR_TEST)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
      gl.enable(gl.SCISSOR_TEST); gl.enable(gl.BLEND)
      const under = rgb(style.outline)
      const drawGroup = (group: number, pass: number, color: number[], alpha: number) => {
        const b = pass >= 2 ? tails[group] : heads[group]
        const x = Math.max(0, Math.floor(b[0] * dpr)), y = Math.max(0, Math.floor(b[1] * dpr))
        const right = Math.min(w, Math.ceil(b[2] * dpr)), bottom = Math.min(h, Math.ceil(b[3] * dpr))
        if (right <= x || bottom <= y || !groups[group].length) return
        gl.scissor(x, h - bottom, right - x, bottom - y)
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer); gl.clear(gl.COLOR_BUFFER_BIT)
        gl.useProgram(maskProgram); gl.bindVertexArray(vao)
        gl.uniform2f(maskResolution, w / dpr, h / dpr); gl.uniform1f(maskDpr, dpr); gl.uniform1i(kind, pass)
        gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 20, starts[group] * 20)
        gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, starts[group] * 20 + 16)
        gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE)
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, groups[group].length)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.useProgram(compositeProgram); gl.bindVertexArray(compositeVao)
        gl.uniform2f(compositeResolution, w / dpr, h / dpr)
        gl.uniform4f(boundsUniform, x / dpr, y / dpr, right / dpr, bottom / dpr)
        gl.uniform4f(paintUniform, color[0], color[1], color[2], alpha)
        gl.blendEquation(gl.FUNC_ADD)
        gl.blendFuncSeparate(gl.ONE, style.darkTheme ? gl.ONE_MINUS_SRC_COLOR : gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
      groups.forEach((_, i) => { if (outlines[i]) drawGroup(i, 1, under, LIGHT_PARTICLE_EDGE_ALPHA) })
      if (!style.darkTheme) groups.forEach((_, i) => drawGroup(i, 2, under, LIGHT_PARTICLE_TAIL_ALPHA))
      groups.forEach((_, i) => drawGroup(i, 3, colors[i], .32))
      groups.forEach((_, i) => drawGroup(i, 0, colors[i], style.darkTheme ? .88 : 1))
      gl.disable(gl.SCISSOR_TEST)
      context.save(); context.setTransform(1, 0, 0, 1, 0, 0)
      context.globalCompositeOperation = 'source-over'; context.globalAlpha = 1; context.drawImage(canvas, 0, 0); context.restore()
      return true
    },
    release() {
      disposed = true
      gl.deleteBuffer(buffer); gl.deleteTexture(texture); gl.deleteFramebuffer(framebuffer)
      gl.deleteVertexArray(vao); gl.deleteVertexArray(compositeVao)
      gl.deleteProgram(maskProgram); gl.deleteProgram(compositeProgram)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.width = canvas.height = 0; source = null; groups = []; data = new Float32Array(0)
    },
  }
}
