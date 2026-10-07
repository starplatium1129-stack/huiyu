/** Original WebGL2 implementation. Texture tiles retain image detail as they
 * separate and dissolve before handing off to the shared generation visual. This is not a port of Telegram's
 * GPL Metal implementation. No CPU particle loop or per-frame texture upload. */
import { registerParticleFrame } from './particleScheduler'
import { visibleGenerationPigment } from './generationPalette'

export interface CanvasParticleMotion {
  stop: () => void
}
export interface GenerationContinuation { clock: number; rotation: number; concentration: number }
interface Options {
  generation?: { progress: () => number | null; palette: readonly string[] }
  onComplete?: () => void
  onHandoff?: (state?: GenerationContinuation) => void
}
const VERTEX = `#version 300 es
precision highp float;
uniform vec2 viewport;
uniform vec4 imageRect;
uniform vec2 grid;
uniform float time;
uniform vec4 handoff;
uniform vec4 orbitState;
uniform vec3 pigments[3];
out vec2 uv;
out vec2 local;
out float alpha;
out float morph;
out float stroke;
out vec3 pigment;
float hash(float n) { return fract(sin(n * 127.13 + 19.7) * 43758.5453); }
// Same trajectory as GenerationParticles; the handoff carries its clock,
// rotation and smoothed progress instead of restarting that animation.
vec2 orbit(float angle,float band) {
  float formed=orbitState.z, finishing=orbitState.w;
  float tilt=(-.64+band*.61)*(1.0-finishing*.75)+sin(orbitState.x*.17+band)*.075*(1.0-finishing);
  float radius=handoff.z*(1.0-formed*.1-finishing*.28)*(.86+band*.08);
  float x=cos(angle)*radius;
  float y=sin(angle)*radius*(.31+band*.035+formed*.1-finishing*.2)+sin(angle*2.0+orbitState.x*.12)*2.5*(1.0-finishing);
  return handoff.xy+vec2(x*cos(tilt)-y*sin(tilt),x*sin(tilt)+y*cos(tilt));
}
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
  vec2 dimensions = mix(cellSize,vec2(.65+seed*1.4),grain);
  alpha = 1.0-smoothstep(.38,1.58,age);
  morph=handoff.w*smoothstep(.45,1.95,time); stroke=0.0; pigment=vec3(0.0);
  float turn=0.0;
  if(handoff.w>0.0) {
    float band=mod(id,3.0), angle=mod(floor(id/3.0),128.0)/128.0*6.2831853;
    float step=6.2831853/128.0, targetAlpha=.32+orbitState.w*.08, lineWidth=1.0;
    bool head=id>=384.0&&id<390.0, trail=id>=390.0&&id<534.0;
    if(head||trail) {
      float index=head?id-384.0:floor((id-390.0)/24.0);
      band=mod(index,3.0);
      float direction=band==1.0?-1.0:1.0;
      angle=floor(index/3.0)*3.14159265+orbitState.y*(direction<0.0?-1.6:1.85)+band*1.64;
      if(trail)angle-=direction*(mod(id-390.0,24.0)+1.0)*.018;
      step=direction*.018; lineWidth=1.25; targetAlpha=head?.95:.65;
    }
    vec2 a=orbit(angle,band), b=orbit(angle+step,band);
    vec2 destination=head?a:(a+b)*.5;
    vec2 targetSize=head?vec2(2.8):vec2(length(b-a)+.3,lineWidth);
    turn=head?0.0:atan(b.y-a.y,b.x-a.x)*morph;
    point=mix(point,destination,morph);
    dimensions=mix(dimensions,targetSize,morph);
    float dustFade=1.0-smoothstep(.3,1.0,morph);
    alpha=id<534.0?mix(1.0,targetAlpha,morph):dustFade;
    stroke=head?0.0:morph;
    pigment=pigments[int(band)];
  }
  vec2 offset=(corner-.5)*dimensions;
  vec2 position = point + vec2(offset.x*cos(turn)-offset.y*sin(turn),offset.x*sin(turn)+offset.y*cos(turn));
  gl_Position = vec4(position/viewport*vec2(2.0,-2.0)+vec2(-1.0,1.0),0,1);
}`
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D artwork;
uniform float time;
in vec2 uv;
in vec2 local;
in float alpha;
in float morph;
in float stroke;
in vec3 pigment;
out vec4 color;
void main() {
  vec4 texel = texture(artwork,uv);
  float mask = mix(1.0,1.0-smoothstep(.62,1.0,length(local)),smoothstep(.1,.7,time));
  mask=mix(mask,1.0,stroke);
  color = vec4(mix(texel.rgb,pigment,morph),mix(texel.a,1.0,morph)*alpha*mask);
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
  let clock=1500, rotation=.27, concentration=options.generation?.progress() ?? 0
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
    const timeUniform=uniform('time'), handoffUniform=uniform('handoff'), orbitUniform=uniform('orbitState')
    let handoffMeasured = !options.generation
    gl.uniform4f(handoffUniform,0,0,0,0)
    const light=host.closest('[data-theme]')?.getAttribute('data-theme')==='light'
    for(let band=0;band<3;band++) {
      const color=visibleGenerationPigment(options.generation?.palette[band] ?? '135 135 135',light).split(' ').map(Number)
      gl.uniform3f(uniform(`pigments[${band}]`),color[0]/255,color[1]/255,color[2]/255)
    }
    gl.uniform2f(uniform('viewport'),bounds.width,bounds.height)
    gl.uniform4f(uniform('imageRect'),left,top,width,height); gl.uniform2f(uniform('grid'),columns,rows)
    gl.uniform1i(uniform('artwork'),0)
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA); gl.viewport(0,0,canvas.width,canvas.height)
    canvas.className='canvas-texture-particles'; canvas.dataset.mode=options.generation?'generation':'clear'; canvas.setAttribute('aria-hidden','true')
    Object.assign(canvas.style,{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none',zIndex:'4'})
    const opacity=Number.parseFloat(getComputedStyle(image).opacity)
    canvas.style.opacity=String(Number.isFinite(opacity) ? opacity : 1)
    canvas.addEventListener('webglcontextlost',contextLost)
    const draw=() => {
      gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform1f(timeUniform,elapsed)
      const smooth=(from:number,to:number) => {const t=Math.max(0,Math.min(1,(concentration-from)/(to-from)));return t*t*(3-2*t)}
      gl.uniform4f(orbitUniform,clock/1000,rotation,smooth(.08,.66),smooth(.65,.98))
      gl.drawArraysInstanced(gl.TRIANGLES,0,6,columns*rows)
    }
    draw(); host.append(canvas); started=true
    /* compositor-exempt: finite, bounded instanced image breakup follows the shared RAF and releases its GPU context. */
    stopFrames=registerParticleFrame((_now,deltaMs) => {
      // Only the empty layout anchor exists here, not the waiting animation.
      // The same particles become its lines before GenerationParticles mounts.
      if (!handoffMeasured) {
        const target = host.querySelector<HTMLElement>('.stage-generation-orbit')?.getBoundingClientRect()
        if (target?.width && target.height) {
          gl.uniform4f(handoffUniform,target.left-bounds.left+target.width/2,target.top-bounds.top+target.height/2,Math.min(target.width*.29,target.height*.3,116),1)
          handoffMeasured=true
        }
      }
      const delta=deltaMs/1000
      elapsed+=delta
      clock+=deltaMs
      const progress=options.generation?.progress()
      if(progress!==null&&progress!==undefined)concentration+=(progress-concentration)*(1-Math.exp(-deltaMs/420))
      rotation+=delta*(.18+concentration*.34)
      if(options.generation) {
        if(elapsed>=2.05) { options.onHandoff?.({clock,rotation,concentration}); finish(); return }
        draw(); return
      }
      if (elapsed>=1.85) { finish(); return }
      if (!handedOff && elapsed>=1.1) { handedOff=true; options.onHandoff?.() }
      draw()
    })
    return { stop:finish }
  } catch { finish(); return null }
}
