/** Original WebGL2 implementation. Texture tiles retain image detail as they
 * separate, gather into a sphere, and release. This is not a port of Telegram's
 * GPL Metal implementation. No CPU particle loop or per-frame texture upload. */
import { registerParticleFrame } from './particleScheduler'

export interface CanvasParticleMotion {
  progress: (value: number | null) => void
  release: () => void
  stop: () => void
}
interface Options {
  mode: 'generation' | 'clear'
  progress?: number | null
  onComplete?: () => void
  onHandoff?: () => void
}
const VERTEX = `#version 300 es
precision highp float;
uniform vec2 viewport;
uniform vec4 imageRect;
uniform vec2 grid;
uniform float time;
uniform float progress;
uniform float releaseTime;
uniform float hasImage;
uniform float clearing;
out vec2 uv;
out vec2 local;
out float alpha;
out float seed;
out float orbPhase;
float hash(float n) { return fract(sin(n * 127.13 + 19.7) * 43758.5453); }
void main() {
  vec2 corners[6] = vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
  vec2 corner = corners[gl_VertexID];
  float id = float(gl_InstanceID);
  seed = hash(id);
  vec2 cell = vec2(mod(id,grid.x),floor(id/grid.x));
  uv = (cell + corner) / grid;
  local = corner * 2.0 - 1.0;
  vec2 source = imageRect.xy + (cell + .5) / grid * imageRect.zw;
  vec2 cellSize = imageRect.zw / grid;
  float delay = (cell.x / grid.x * .14 + seed * .16) * hasImage;
  float age = max(0.0,time-delay);
  float grain = smoothstep(.02,.48,age);
  float gather = hasImage > .5 ? smoothstep(.16,1.38,age) : 1.0;
  float a = id * 2.39996323 + time * .16;
  float z = 1.0 - 2.0 * (id + .5) / (grid.x * grid.y);
  float ring = sqrt(max(0.0,1.0-z*z));
  vec3 sphere = vec3(cos(a)*ring,z,sin(a)*ring);
  sphere.yz = mat2(.961,-.276,.276,.961) * sphere.yz;
  float radius = min(100.0,min(viewport.x*.23,viewport.y*.25)) * (1.0 - progress*.64);
  vec2 center = viewport * vec2(.5,.43);
  vec2 orbit = center + sphere.xy * radius * (.89 + seed*.11);
  vec2 breeze = vec2(cos(seed*6.283),sin(seed*6.283)) * (12.0+seed*28.0);
  vec2 point = mix(source,orbit,gather) + breeze*sin(gather*3.14159);
  float depth = sphere.z*.5+.5;
  orbPhase = clearing > .5 ? 0.0 : gather;
  float size = mix(.75 + depth*1.4,1.2 + depth*1.7,gather);
  vec2 dimensions = mix(cellSize,vec2(size),grain);
  // Irregular retention avoids visible latitude bands from every-nth sampling.
  float retained = step(.78,hash(id + 71.2));
  alpha = mix(1.0,(.32+depth*.66)*retained,gather);
  if (hasImage < .5) { alpha = .28+depth*.66; dimensions=vec2(size); }
  if (clearing > .5) {
    float flight = max(0.0,age-.03);
    point = source + breeze*flight + vec2(sin(seed*17.0+flight*3.0)*12.0*flight,-26.0*flight*flight);
    dimensions = mix(cellSize,vec2(.65+seed*1.4),grain);
    alpha = 1.0-smoothstep(.38,1.58,age);
  } else if (releaseTime >= 0.0) {
    float burst = clamp(releaseTime/.72,0.0,1.0);
    vec2 direction = normalize(sphere.xy+vec2(.0001));
    point += direction*(32.0+seed*150.0)*burst + breeze*burst*burst;
    dimensions *= 1.0-.5*burst;
    alpha *= 1.0-smoothstep(.02,1.0,burst);
  }
  vec2 position = point + (corner-.5)*dimensions;
  gl_Position = vec4(position/viewport*vec2(2.0,-2.0)+vec2(-1.0,1.0),0,1);
}`
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D artwork;
uniform float hasImage;
uniform float time;
uniform vec3 accent;
in vec2 uv;
in vec2 local;
in float alpha;
in float seed;
in float orbPhase;
out vec4 color;
void main() {
  vec4 texel = texture(artwork,uv);
  vec3 tone = mix(accent,vec3(.40,.77,.81),step(.48,seed));
  tone = mix(tone,vec3(.71,.60,.85),step(.76,seed));
  float roundness = smoothstep(.1,.7,time);
  float mask = mix(1.0,1.0-smoothstep(.62,1.0,length(local)),roundness);
  vec3 pigment = mix(tone,texel.rgb,hasImage);
  // Only the gathered orb gets a gentle luminance floor: dark source artwork
  // must still read as loading. Source tiles and standalone clear keep fidelity.
  float luminance = dot(pigment,vec3(.2126,.7152,.0722));
  float lift = max(0.0,.58-luminance)/max(.001,1.0-luminance);
  pigment = mix(pigment,vec3(1.0),lift*smoothstep(.28,.95,orbPhase));
  color = vec4(pigment,mix(1.0,texel.a,hasImage)*alpha*mask);
}`

/** Only a single, low-power context exists for this transition. Texture/backing
 * sizes are bounded independently of screen DPR and source image dimensions. */
export function startCanvasTextureParticles(image: HTMLImageElement | null, host: HTMLElement, options: Options): CanvasParticleMotion | null {
  const bounds = host.getBoundingClientRect()
  if (!(bounds.width > 0 && bounds.height > 0)) return null
  if (image && (!image.complete || !image.naturalWidth || !image.naturalHeight)) return null
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
  let elapsed = 0, lastTime: number | null = null, releasedAt: number | null = null
  let concentration = Math.max(0, Math.min(1, options.progress ?? 0))
  let targetProgress = concentration
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
    if (image) {
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
    } else gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]))
    const count = image ? Math.min(18000,Math.max(1800,Math.round(width*height/20))) : 1100
    const columns=Math.max(1,Math.round(Math.sqrt(count*width/height))), rows=Math.max(1,Math.floor(count/columns))
    const uniform = (name: string) => gl.getUniformLocation(program!,name)
    const timeUniform=uniform('time'), progressUniform=uniform('progress'), releaseUniform=uniform('releaseTime')
    gl.uniform2f(uniform('viewport'),bounds.width,bounds.height)
    gl.uniform4f(uniform('imageRect'),left,top,width,height); gl.uniform2f(uniform('grid'),columns,rows)
    gl.uniform1f(uniform('hasImage'),image ? 1 : 0); gl.uniform1f(uniform('clearing'),options.mode==='clear' ? 1 : 0)
    gl.uniform3f(uniform('accent'),.85,.66,.73); gl.uniform1i(uniform('artwork'),0)
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA); gl.viewport(0,0,canvas.width,canvas.height)
    canvas.className='canvas-texture-particles'; canvas.dataset.mode=options.mode; canvas.setAttribute('aria-hidden','true')
    Object.assign(canvas.style,{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none',zIndex:'4'})
    const opacity=image ? Number.parseFloat(getComputedStyle(image).opacity) : 1
    canvas.style.opacity=String(Number.isFinite(opacity) ? opacity : 1)
    canvas.addEventListener('webglcontextlost',contextLost)
    const draw=() => {
      gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform1f(timeUniform,elapsed); gl.uniform1f(progressUniform,concentration)
      gl.uniform1f(releaseUniform,releasedAt===null ? -1 : elapsed-releasedAt)
      gl.drawArraysInstanced(gl.TRIANGLES,0,6,columns*rows)
    }
    draw(); host.append(canvas); started=true
    /* compositor-exempt: bounded instanced GPU texture particles, one draw at
     * 30fps while the generation engine competes for GPU, no per-frame readback. */
    stopFrames=registerParticleFrame(now => {
      const delta=lastTime===null ? 0 : Math.min(.08,(now-lastTime)/1000)
      lastTime=now; elapsed+=delta
      concentration+=(targetProgress-concentration)*(1-Math.exp(-delta/0.32))
      if (options.mode==='clear' && elapsed>=1.85 || releasedAt!==null && elapsed-releasedAt>=.74) { finish(); return }
      if (!handedOff && options.mode==='clear' && elapsed>=1.1) { handedOff=true; options.onHandoff?.() }
      draw()
    },30)
    return {
      progress(value) { if (value!==null && Number.isFinite(value)) targetProgress=Math.max(0,Math.min(1,value)) },
      release() { if (releasedAt===null) releasedAt=elapsed },
      stop:finish,
    }
  } catch { finish(); return null }
}
