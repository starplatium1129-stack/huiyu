/** Original WebGL2 texture-particle implementation; Telegram-inspired dust motion,
 * independently written. One canvas owns breakup, waiting and decoded-result reveal. */
import { registerParticleFrame } from './particleScheduler'
import { sampleGenerationPalette, visibleGenerationPigment } from './generationPalette'

export interface CanvasParticleReveal { stop: () => void; finished: Promise<void> }
export interface CanvasParticleMotion {
  stop: () => void
  reveal: (image: HTMLImageElement) => CanvasParticleReveal | null
}
interface Options {
  generation?: { progress: () => number | null; palette: readonly string[] }
  onComplete?: () => void
  onHandoff?: () => void
}
const VERTEX = `#version 300 es
precision highp float;
uniform vec2 viewport;
uniform vec4 imageRect;
uniform vec3 orbitCenter;
uniform float clock;
uniform float morph;
uniform float dustTime;
uniform float clearing;
out vec2 uv;
out vec2 local;
out float mixColor;
out float alpha;
out float rounding;
flat out int band;
float hash(float n){return fract(sin(n*127.13+19.7)*43758.5453);}
void main(){
 vec2 corners[6]=vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
 vec2 corner=corners[gl_VertexID], grid=vec2(132,192);
 float id=float(gl_InstanceID), seed=hash(id), lane=mod(id,3.0); band=int(lane);
 vec2 cell=vec2(mod(id,grid.x),floor(id/grid.x)); uv=(cell+corner)/grid; local=corner*2.0-1.0;
 vec2 normalized=(cell+.5)/grid-.5, source=imageRect.xy+(cell+.5)/grid*imageRect.zw;
 float distance=length(normalized)*1.414;
 float m=clamp((morph-.105*distance)/.895,0.0,1.0); m=m*m*(3.0-2.0*m);
 float angle=atan(normalized.y,normalized.x)+distance*2.2+clock*(lane==1.0?-.31:.28)+lane*1.4;
 float tilt=-.66+lane*.63+sin(clock*.16+lane)*.045;
 float radius=orbitCenter.z*(.9+lane*.055);
 vec2 orbit=vec2(cos(angle)*radius,sin(angle)*radius*(.34+lane*.035));
 orbit=vec2(orbit.x*cos(tilt)-orbit.y*sin(tilt),orbit.x*sin(tilt)+orbit.y*cos(tilt));
 vec2 destination=orbitCenter.xy+orbit+vec2(cos(seed*6.283),sin(seed*6.283))*(.5+seed*1.3);
 vec2 position=mix(source,destination,m);
 position+=vec2(-normalized.y,normalized.x)*sin(m*3.14159)*min(viewport.x,viewport.y)*.13;
 vec2 ringSize=vec2(.8+seed*.6);
 float ringAlpha=.24+seed*.17;
 vec2 dimensions=mix(imageRect.zw/grid*1.003,ringSize,smoothstep(0.0,.82,m));
 mixColor=smoothstep(.28,.94,m); rounding=mixColor; alpha=mix(1.0,ringAlpha,m);
 if(dustTime>=0.0){
  float delay=(cell.x/grid.x)*.30+(cell.y/grid.y)*.07+seed*.11;
  float age=max(0.0,dustTime-delay), grain=smoothstep(.015,.42,age);
  float flight=max(0.0,age-.025), drift=flight*(1.0-exp(-flight*6.0));
  vec2 wind=vec2(34.0+seed*49.0,-8.0-hash(id+7.0)*17.0);
  vec2 flutter=vec2(sin(seed*21.0+flight*3.0),cos(seed*17.0+flight*2.2)*.5)*flight*flight*8.0;
  vec2 blown=source+wind*drift+flutter;
  vec2 dustSize=mix(imageRect.zw/grid*1.003,vec2(.65+seed*.7),grain);
  float dustAlpha=1.0-smoothstep(.60+seed*.16,1.75+seed*.16,age);
  float join=clearing>.5?0.0:smoothstep(.55,2.0,dustTime);
  vec2 offset=blown-orbitCenter.xy;
  position=mix(blown,destination,join)+vec2(-offset.y,offset.x)*sin(join*3.14159)*.20;
  dimensions=mix(dustSize,ringSize,join);alpha=mix(dustAlpha,ringAlpha,join);
  mixColor=join*join;rounding=mix(grain,1.0,join);
 }
 position+=(corner-.5)*dimensions;
 gl_Position=vec4(position/viewport*vec2(2.0,-2.0)+vec2(-1.0,1.0),0,1);
}`
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D artwork;
uniform vec3 pigments[3];
uniform float light;
in vec2 uv;
in vec2 local;
in float mixColor;
in float alpha;
in float rounding;
flat in int band;
out vec4 color;
void main(){
 vec4 texel=texture(artwork,uv);
 float luminance=dot(texel.rgb,vec3(.2126,.7152,.0722));
 vec3 ink=texel.rgb*min(1.0,.42/max(luminance,.001));
 vec3 textureColor=mix(texel.rgb,ink,light*rounding);
 float coverage=mix(alpha,pow(max(alpha,0.0),.76),light*rounding);
 float mask=mix(1.0,1.0-smoothstep(.62,1.0,length(local)),rounding);
 color=vec4(mix(textureColor,pigments[band],mixColor),texel.a*coverage*mask);
}`

/** Normal motion follows every display RAF, with bounded texture and backing sizes.
 * A null source starts the same orbit on an empty canvas. */
export function startCanvasTextureParticles(image: HTMLImageElement | null, host: HTMLElement, options: Options): CanvasParticleMotion | null {
  const bounds = host.getBoundingClientRect()
  if (!(bounds.width > 0 && bounds.height > 0)) return null
  if (image && (!image.complete || !image.naturalWidth || !image.naturalHeight)) return null
  if (!image && !options.generation) return null
  const canvas = document.createElement('canvas')
  const scale = Math.min(window.devicePixelRatio || 1, 1.6, 1440 / Math.max(bounds.width, bounds.height), Math.sqrt(900_000 / (bounds.width * bounds.height)))
  canvas.width = Math.max(1, Math.floor(bounds.width * scale)); canvas.height = Math.max(1, Math.floor(bounds.height * scale))
  let gl: WebGL2RenderingContext | null
  try { gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'low-power' }) }
  catch { return null }
  if (!gl) return null
  const shaders: WebGLShader[] = []
  let program: WebGLProgram | null = null, texture: WebGLTexture | null = null, vao: WebGLVertexArrayObject | null = null
  let stopFrames: (() => void) | null = null
  let disposed = false, started = false, handedOff = false, elapsed = 0, clock = 1.5
  let concentration = options.generation?.progress() ?? 0
  let revealElapsed: number | null = null
  let pendingImage: HTMLImageElement | null = null, restoreImage: (() => void) | null = null, resolveReveal: (() => void) | null = null
  let revealEffect: CanvasParticleReveal | null = null
  const finish = () => {
    if (disposed) return
    disposed = true
    stopFrames?.(); stopFrames = null
    restoreImage?.(); restoreImage = null; pendingImage = null
    resolveReveal?.(); resolveReveal = null
    canvas.removeEventListener('webglcontextlost', contextLost)
    gl.deleteTexture(texture); gl.deleteVertexArray(vao); gl.deleteProgram(program)
    shaders.forEach(shader => gl.deleteShader(shader))
    canvas.remove(); canvas.width = canvas.height = 0
    if (!gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext()
    if (started) options.onComplete?.()
  }
  function contextLost(event: Event) { event.preventDefault(); finish() }
  try {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('Shader unavailable')
      shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Shader compilation failed')
      return shader
    }
    program = gl.createProgram()
    if (!program) throw new Error('Program unavailable')
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX)); gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Program linking failed')
    gl.useProgram(program)
    vao = gl.createVertexArray(); gl.bindVertexArray(vao)
    texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const uniform = (name: string) => gl.getUniformLocation(program!, name)
    const imageUniform = uniform('imageRect'), clockUniform = uniform('clock'), morphUniform = uniform('morph'), dustUniform = uniform('dustTime'), lightUniform = uniform('light')
    const pigmentUniforms = [0, 1, 2].map(band => uniform(`pigments[${band}]`))
    function capture(next: HTMLImageElement) {
      const rect = next.getBoundingClientRect()
      if (!(rect.width > 0 && rect.height > 0)) throw new Error('Image bounds unavailable')
      const fit = Math.min(rect.width / next.naturalWidth, rect.height / next.naturalHeight)
      const width = next.naturalWidth * fit, height = next.naturalHeight * fit
      const snapshot = document.createElement('canvas')
      const ratio = Math.min(1, 1280 / Math.max(next.naturalWidth, next.naturalHeight), Math.sqrt(800_000 / (next.naturalWidth * next.naturalHeight)))
      snapshot.width = Math.max(1, Math.floor(next.naturalWidth * ratio)); snapshot.height = Math.max(1, Math.floor(next.naturalHeight * ratio))
      try {
        const paint = snapshot.getContext('2d')
        if (!paint) throw new Error('Snapshot unavailable')
        paint.drawImage(next, 0, 0, snapshot.width, snapshot.height)
        gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, snapshot)
      } finally { snapshot.width = snapshot.height = 0 }
      gl!.uniform4f(imageUniform, rect.left - bounds.left - host.clientLeft + (rect.width - width) / 2,
        rect.top - bounds.top - host.clientTop + (rect.height - height) / 2, width, height)
    }
    if (image) capture(image)
    else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
      gl.uniform4f(imageUniform, 0, 0, bounds.width, bounds.height)
    }
    const palette = options.generation?.palette.length === 3 ? [...options.generation.palette] : image ? sampleGenerationPalette(image) : []
    const themeRoot = host.closest<HTMLElement>('[data-theme]') ?? document.documentElement
    let lastTheme: boolean | undefined
    const appearance = () => {
      const light = themeRoot.dataset.theme === 'light'
      if (lastTheme === light) return
      lastTheme = light
      for (let band = 0; band < 3; band++) {
        const color = visibleGenerationPigment(palette[band] ?? '170 125 150', light).split(' ').map(Number)
        gl.uniform3f(pigmentUniforms[band], color[0] / 255, color[1] / 255, color[2] / 255)
      }
      gl.uniform1f(lightUniform, light ? 1 : 0)
    }
    gl.uniform2f(uniform('viewport'), bounds.width, bounds.height)
    gl.uniform3f(uniform('orbitCenter'), bounds.width / 2, bounds.height * .43, Math.min(bounds.width * .23, bounds.height * .27, 136))
    gl.uniform1f(uniform('clearing'), options.generation ? 0 : 1); gl.uniform1i(uniform('artwork'), 0)
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.viewport(0, 0, canvas.width, canvas.height)
    canvas.className = 'canvas-texture-particles'; canvas.dataset.mode = options.generation ? 'generation' : 'clear'; canvas.setAttribute('aria-hidden', 'true')
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '4' })
    const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * t * (t * (t * 6 - 15) + 10) }
    const draw = () => {
      appearance(); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform1f(clockUniform, clock)
      gl.uniform1f(morphUniform, revealElapsed === null ? 1 : 1 - smooth(revealElapsed / 1.25))
      gl.uniform1f(dustUniform, revealElapsed !== null ? -1 : !options.generation || (image && elapsed < 2) ? elapsed : -1)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 132 * 192)
    }
    const beginReveal = () => {
      if (!pendingImage) return
      capture(pendingImage); pendingImage = null; revealElapsed = 0; canvas.dataset.mode = 'reveal'
    }
    canvas.addEventListener('webglcontextlost', contextLost)
    draw(); host.append(canvas); started = true
    /* compositor-exempt: bounded instanced particles share the display RAF; no FPS cap, per-frame texture upload or CPU particle loop. */
    stopFrames = registerParticleFrame((_now, deltaMs) => {
      elapsed += deltaMs / 1000
      const progress = options.generation?.progress()
      if (progress !== null && progress !== undefined) concentration += (progress - concentration) * (1 - Math.exp(-deltaMs / 420))
      clock += deltaMs / 1000 * (.85 + concentration * .3)
      try {
        if (revealElapsed !== null) {
          revealElapsed += deltaMs / 1000
          if (revealElapsed >= 1.25) { finish(); return }
        } else if (pendingImage && (!image || elapsed >= 2)) beginReveal()
        if (!options.generation) {
          if (elapsed >= 2.4) { finish(); return }
          if (!handedOff && elapsed >= 1.65) { handedOff = true; options.onHandoff?.() }
        }
        draw()
      } catch { finish() }
    })
    return {
      stop: finish,
      reveal(next) {
        if (disposed || !options.generation || !next.complete || !next.naturalWidth || !next.naturalHeight) return null
        if (revealEffect) return revealEffect
        const opacity = next.style.opacity
        next.style.opacity = '0'; restoreImage = () => { next.style.opacity = opacity }
        pendingImage = next
        revealEffect = { stop: finish, finished: new Promise<void>(resolve => { resolveReveal = resolve }) }
        try { if (!image || elapsed >= 2) beginReveal(); draw() }
        catch { finish(); return null }
        return revealEffect
      },
    }
  } catch { finish(); return null }
}
