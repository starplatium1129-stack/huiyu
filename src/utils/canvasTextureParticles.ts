/** Original WebGL2 implementation. Texture tiles retain image detail as they
 * separate and dissolve before handing off to the shared generation visual. This is not a port of Telegram's
 * GPL Metal implementation. No CPU particle loop or per-frame texture upload. */
import { registerParticleFrame } from './particleScheduler'

export interface CanvasParticleMotion {
  stop: () => void
}
interface Options {
  gather?: boolean
  onComplete?: () => void
  onHandoff?: () => void
}
const VERTEX = `#version 300 es
precision highp float;
uniform vec2 viewport;
uniform vec4 imageRect;
uniform vec2 grid;
uniform float time;
uniform vec4 handoff;
out vec2 uv;
out vec2 local;
out float alpha;
float hash(float n) { return fract(sin(n * 127.13 + 19.7) * 43758.5453); }
void main() {
  vec2 corners[6] = vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
  vec2 corner = corners[gl_VertexID];
  float id = float(gl_InstanceID), seed = hash(id);
  vec2 cell = vec2(mod(id,grid.x),floor(id/grid.x));
  uv = (cell + corner) / grid;
  local = corner * 2.0 - 1.0;
  vec2 source = imageRect.xy + (cell + .5) / grid * imageRect.zw;
  vec2 cellSize = imageRect.zw / grid;
  float age = max(0.0,time-(cell.x / grid.x * .14 + seed * .16));
  float grain = smoothstep(.02,.48,age), flight = max(0.0,age-.03);
  vec2 breeze = vec2(cos(seed*6.283),sin(seed*6.283)) * (12.0+seed*28.0);
  vec2 point = source + breeze*flight + vec2(sin(seed*17.0+flight*3.0)*12.0*flight,-26.0*flight*flight);
  float gathering = handoff.w*smoothstep(.4,1.45,time);
  float band = mod(id,3.0), angle = seed*6.283+time*.3;
  float tilt = -.64+band*.61;
  vec2 orbit = vec2(cos(angle),sin(angle)*(.31+band*.035))*handoff.z*(.86+band*.08);
  vec2 destination = handoff.xy+vec2(orbit.x*cos(tilt)-orbit.y*sin(tilt),orbit.x*sin(tilt)+orbit.y*cos(tilt));
  point = mix(point,destination,gathering);
  vec2 dimensions = mix(cellSize,vec2(.65+seed*1.4),grain);
  alpha = (1.0-smoothstep(.38,1.58,age))*(1.0-gathering*.85);
  vec2 position = point + (corner-.5)*dimensions;
  gl_Position = vec4(position/viewport*vec2(2.0,-2.0)+vec2(-1.0,1.0),0,1);
}`
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D artwork;
uniform float time;
in vec2 uv;
in vec2 local;
in float alpha;
out vec4 color;
void main() {
  vec4 texel = texture(artwork,uv);
  float mask = mix(1.0,1.0-smoothstep(.62,1.0,length(local)),smoothstep(.1,.7,time));
  color = vec4(texel.rgb,texel.a*alpha*mask);
}`

/** Only a single, low-power context exists for this transition. Texture/backing
 * sizes are bounded independently of screen DPR and source image dimensions. */
export function startCanvasTextureParticles(image: HTMLImageElement, host: HTMLElement, options: Options): CanvasParticleMotion | null {
  const bounds = host.getBoundingClientRect()
  if (!(bounds.width > 0 && bounds.height > 0)) return null
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) return null
  const canvas = document.createElement('canvas')
  const backingScale = Math.min(window.devicePixelRatio || 1, 1.5, 1440 / Math.max(bounds.width,bounds.height), Math.sqrt(1_000_000/(bounds.width*bounds.height)))
  canvas.width = Math.max(1,Math.floor(bounds.width*backingScale))
  canvas.height = Math.max(1,Math.floor(bounds.height*backingScale))
  let gl: WebGL2RenderingContext | null
  try { gl = canvas.getContext('webgl2', { alpha:true, antialias:false, depth:false, stencil:false, powerPreference:'low-power', preserveDrawingBuffer:false }) }
  catch { return null }
  if (!gl) return null
  const shaders: WebGLShader[] = []
  let program: WebGLProgram | null = null, texture: WebGLTexture | null = null, vao: WebGLVertexArrayObject | null = null
  let stopFrames: (() => void) | null = null
  let disposed = false, started = false, handedOff = false
  let elapsed = 0
  const finish = () => {
    if (disposed) return
    disposed = true
    stopFrames?.(); stopFrames = null
    canvas.removeEventListener('webglcontextlost', contextLost)
    gl.deleteTexture(texture); gl.deleteVertexArray(vao); gl.deleteProgram(program)
    shaders.forEach(shader => gl.deleteShader(shader))
    canvas.remove(); canvas.width = canvas.height = 0
    // Release this finite context rather than retaining GPU resources until GC.
    if (!gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext()
    if (started) options.onComplete?.()
  }
  function contextLost(event: Event) { event.preventDefault(); finish() }
  try {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('Shader unavailable')
      shaders.push(shader); gl.shaderSource(shader,source); gl.compileShader(shader)
      if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error('Shader compilation failed')
      return shader
    }
    program = gl.createProgram()
    if (!program) throw new Error('Program unavailable')
    gl.attachShader(program,compile(gl.VERTEX_SHADER,VERTEX)); gl.attachShader(program,compile(gl.FRAGMENT_SHADER,FRAGMENT))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error('Program linking failed')
    gl.useProgram(program)
    vao = gl.createVertexArray(); gl.bindVertexArray(vao)
    texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,texture)
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE)
    let left = 0, top = 0, width = bounds.width, height = bounds.height
    {
      const rect = image.getBoundingClientRect()
      if (!(rect.width > 0 && rect.height > 0)) throw new Error('Image bounds unavailable')
      const fit = Math.min(rect.width/image.naturalWidth,rect.height/image.naturalHeight)
      width=image.naturalWidth*fit; height=image.naturalHeight*fit
      left=rect.left-bounds.left-host.clientLeft+(rect.width-width)/2
      top=rect.top-bounds.top-host.clientTop+(rect.height-height)/2
      const snapshot = document.createElement('canvas')
      const scale = Math.min(1,1280/Math.max(image.naturalWidth,image.naturalHeight),Math.sqrt(800_000/(image.naturalWidth*image.naturalHeight)))
      snapshot.width=Math.max(1,Math.floor(image.naturalWidth*scale)); snapshot.height=Math.max(1,Math.floor(image.naturalHeight*scale))
      try {
        const context=snapshot.getContext('2d')
        if (!context) throw new Error('Snapshot unavailable')
        context.drawImage(image,0,0,snapshot.width,snapshot.height)
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,snapshot)
      } finally { snapshot.width=snapshot.height=0 }
    }
    const count = Math.min(18000,Math.max(1800,Math.round(width*height/20)))
    const columns=Math.max(1,Math.round(Math.sqrt(count*width/height))), rows=Math.max(1,Math.floor(count/columns))
    const uniform = (name: string) => gl.getUniformLocation(program!,name)
    const timeUniform=uniform('time'), handoffUniform=uniform('handoff')
    let handoffMeasured = !options.gather
    gl.uniform4f(handoffUniform,0,0,0,0)
    gl.uniform2f(uniform('viewport'),bounds.width,bounds.height)
    gl.uniform4f(uniform('imageRect'),left,top,width,height); gl.uniform2f(uniform('grid'),columns,rows)
    gl.uniform1i(uniform('artwork'),0)
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA); gl.viewport(0,0,canvas.width,canvas.height)
    canvas.className='canvas-texture-particles'; canvas.dataset.mode='clear'; canvas.setAttribute('aria-hidden','true')
    Object.assign(canvas.style,{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none',zIndex:'4'})
    const opacity=Number.parseFloat(getComputedStyle(image).opacity)
    canvas.style.opacity=String(Number.isFinite(opacity) ? opacity : 1)
    canvas.addEventListener('webglcontextlost',contextLost)
    const draw=() => {
      gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform1f(timeUniform,elapsed)
      gl.drawArraysInstanced(gl.TRIANGLES,0,6,columns*rows)
    }
    draw(); host.append(canvas); started=true
    /* compositor-exempt: finite, bounded instanced image breakup follows the shared RAF and releases its GPU context. */
    stopFrames=registerParticleFrame((_now,deltaMs) => {
      // The waiting visual mounts in Vue's next patch. Measure its real local
      // center once, so the fragments join the same orbit in any canvas size.
      if (!handoffMeasured) {
        const target = host.querySelector<HTMLElement>('.generation-particle-surface')?.getBoundingClientRect()
        if (target?.width && target.height) {
          gl.uniform4f(handoffUniform,target.left-bounds.left+target.width/2,target.top-bounds.top+target.height/2,Math.min(target.width*.29,target.height*.3,116),1)
          handoffMeasured=true
        }
      }
      const delta=deltaMs/1000
      elapsed+=delta
      if (elapsed>=1.85) { finish(); return }
      if (!handedOff && elapsed>=(options.gather ? .55 : 1.1)) { handedOff=true; options.onHandoff?.() }
      draw()
    })
    return { stop:finish }
  } catch { finish(); return null }
}
