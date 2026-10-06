/** Original WebGL2 implementation. Texture tiles retain image detail as they
 * separate, join flowing rings, and release. This is not a port of Telegram's
 * GPL Metal implementation. No CPU particle loop or per-frame texture upload. */
import { registerParticleFrame } from './particleScheduler'
import { visibleGenerationPigment } from './generationPalette'

export interface CanvasParticleMotion {
  progress: (value: number | null) => void
  release: () => void
  refreshPalette: () => void
  stop: () => void
}
interface Options {
  mode: 'generation' | 'clear'
  progress?: number | null
  palette?: readonly string[]
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
uniform float rotation;
uniform float releaseTime;
uniform float hasImage;
uniform float clearing;
uniform float fragments;
out vec2 uv;
out vec2 local;
out float alpha;
out float seed;
out float orbPhase;
out float tone;
out float ribbon;
float hash(float n) { return fract(sin(n * 127.13 + 19.7) * 43758.5453); }
vec3 orbit(float a, float band, float radius) {
  float formed = smoothstep(.08,.66,progress), finishing = smoothstep(.65,.98,progress);
  float tilt = (-.64 + band*.61)*(1.0-finishing*.75) + sin(time*.17+band)*.075*(1.0-finishing);
  vec2 p = vec2(cos(a),sin(a)*(.31+band*.035+formed*.1-finishing*.2)) * radius * (.86+band*.08);
  p.y += sin(a*2.0+time*.12)*2.5*(1.0-finishing);
  return vec3(mat2(cos(tilt),sin(tilt),-sin(tilt),cos(tilt))*p,sin(a)*.5+.5);
}
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
  float formed = smoothstep(.08,.66,progress), finishing = smoothstep(.65,.98,progress);
  float radius = min(116.0,min(viewport.x*.29,viewport.y*.25)) * (1.0 - formed*.1 - finishing*.28);
  vec2 center = viewport * vec2(.5,.43);
  float band = mod(id,3.0);
  vec3 track = orbit(id*2.39996323+rotation,band,radius);
  vec2 breeze = vec2(cos(seed*6.283),sin(seed*6.283)) * (12.0+seed*28.0);
  vec2 point = mix(source,center+track.xy,gather) + breeze*sin(gather*3.14159);
  float depth = track.z;
  orbPhase = clearing > .5 ? 0.0 : gather;
  tone = band;
  ribbon = 0.0;
  float size = mix(.75 + depth*1.4,3.4 + depth*2.0,gather);
  vec2 dimensions = mix(cellSize,vec2(size),grain);
  // Irregular retention avoids visible latitude bands from every-nth sampling.
  float retained = step(1.0-78.0/(grid.x*grid.y),hash(id + 71.2));
  alpha = mix(1.0,(.24+depth*.5)*retained,gather) * (1.0-smoothstep(1.65,2.45,age));
  if (clearing > .5) {
    float flight = max(0.0,age-.03);
    point = source + breeze*flight + vec2(sin(seed*17.0+flight*3.0)*12.0*flight,-26.0*flight*flight);
    dimensions = mix(cellSize,vec2(.65+seed*1.4),grain);
    alpha = 1.0-smoothstep(.38,1.58,age);
  } else if (fragments < .5 || id >= grid.x*grid.y) {
    float index = fragments < .5 ? id : id-grid.x*grid.y;
    band = floor(index/128.0);
    float a = mod(index,128.0)/128.0*6.2831853;
    if (index < 384.0) {
      ribbon = 1.0;
      vec3 next = orbit(a+.0490874,band,radius);
      track = orbit(a,band,radius);
      vec2 direction = next.xy-track.xy;
      vec2 normal = normalize(vec2(-direction.y,direction.x));
      point = center+mix(track.xy,next.xy,corner.x)+normal*(corner.y-.5)*1.8;
      dimensions = vec2(0.0);
      alpha = .32+finishing*.08;
    } else {
      float dotId = index-384.0;
      float tail = dotId >= 78.0 && dotId < 114.0 ? mod(dotId-78.0,6.0)+1.0 : 0.0;
      if (tail > 0.0) dotId = 72.0+floor((dotId-78.0)/6.0);
      band = mod(dotId,3.0);
      a = floor(dotId/3.0)/24.0*6.2831853+rotation+band*1.5;
      if (dotId >= 72.0) a = rotation*(band==1.0 ? -1.6 : 1.85)+band*1.64+floor((dotId-72.0)/3.0)*3.1415927;
      a -= (band==1.0 ? -1.0 : 1.0)*tail*(.035+formed*.02);
      track = orbit(a,band,radius);
      point = center+track.xy;
      dimensions = vec2(dotId < 72.0 ? 3.0+track.z*2.0 : 8.0);
      alpha = dotId < 72.0 ? .24+track.z*.58 : .95;
      if (tail > 0.0) {
        dimensions = vec2(3.0*(1.0-tail/9.0));
        alpha = (.16+formed*.26)*(1.0-tail/7.0);
      }
      if (index >= 498.0) {
        float core = index-498.0;
        a = core*2.39996323+rotation*.6;
        float distance = radius*(.38-finishing*.22)*(1.0+sin(core*1.7)*.35);
        point = center+vec2(cos(a),sin(a)*.65)*distance;
        band = mod(core,3.0); dimensions = vec2(2.0);
        alpha = finishing*(.3+sin(core*2.1+time)*.1);
      }
    }
    tone = band; orbPhase = 1.0;
    alpha *= hasImage > .5 ? smoothstep(1.1,2.45,time) : 1.0;
  }
  if (clearing < .5 && releaseTime >= 0.0) {
    float burst = clamp(releaseTime/.96,0.0,1.0);
    vec2 direction = normalize(point-center+vec2(.0001));
    point += direction*(18.0+seed*36.0)*burst;
    dimensions *= 1.0-.25*burst;
    alpha *= 1.0-smoothstep(0.0,1.0,burst);
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
uniform vec3 cyan;
uniform vec3 violet;
in vec2 uv;
in vec2 local;
in float alpha;
in float seed;
in float orbPhase;
in float tone;
in float ribbon;
out vec4 color;
void main() {
  vec4 texel = texture(artwork,uv);
  vec3 tint = tone < .5 ? accent : tone < 1.5 ? cyan : violet;
  float roundness = smoothstep(.1,.7,time);
  float mask = mix(1.0,1.0-smoothstep(.62,1.0,length(local)),roundness);
  float core = 1.0-smoothstep(.26,.46,length(local));
  float halo = exp(-dot(local,local)*3.2)*(1.0-smoothstep(.75,1.0,length(local)))*.18;
  mask = mix(mask,max(core,halo),orbPhase);
  if (ribbon > .5) mask = 1.0-smoothstep(.55,1.0,abs(local.y));
  vec3 pigment = mix(texel.rgb,tint,1.0-hasImage*(1.0-orbPhase));
  color = vec4(pigment,mix(1.0,texel.a,hasImage*(1.0-orbPhase))*alpha*mask);
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
  let elapsed = 0, rotation = 0, releasedAt: number | null = null
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
    const timeUniform=uniform('time'), progressUniform=uniform('progress'), rotationUniform=uniform('rotation'), releaseUniform=uniform('releaseTime'), fragmentsUniform=uniform('fragments')
    gl.uniform2f(uniform('viewport'),bounds.width,bounds.height)
    gl.uniform4f(uniform('imageRect'),left,top,width,height); gl.uniform2f(uniform('grid'),columns,rows)
    gl.uniform1f(uniform('hasImage'),image ? 1 : 0); gl.uniform1f(uniform('clearing'),options.mode==='clear' ? 1 : 0)
    const refreshPalette = () => {
      if (disposed) return
      const style=getComputedStyle(host), probe=document.createElement('canvas')
      probe.width=3; probe.height=1
      const paint=probe.getContext('2d')
      const palette=[['accent','--accent','#efabc8'],['cyan','--archive-cyan','#9ddddd'],['violet','--accent-violet','#bdb0e8']]
      try {
        if (!paint) return
        const light = host.closest('[data-theme]')?.getAttribute('data-theme') === 'light'
        palette.forEach(([,name,fallback],index) => {
          paint.fillStyle=options.palette?.length===3 ? `rgb(${visibleGenerationPigment(options.palette[index],light)})` : style.getPropertyValue(name).trim() || fallback
          paint.fillRect(index,0,1,1)
        })
        const pixels=paint.getImageData(0,0,3,1).data
        gl.useProgram(program)
        palette.forEach(([name],index) => gl.uniform3f(uniform(name),pixels[index*4]/255,pixels[index*4+1]/255,pixels[index*4+2]/255))
      } finally { probe.width=probe.height=0 }
    }
    refreshPalette(); gl.uniform1i(uniform('artwork'),0)
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA); gl.viewport(0,0,canvas.width,canvas.height)
    canvas.className='canvas-texture-particles'; canvas.dataset.mode=options.mode; canvas.setAttribute('aria-hidden','true')
    Object.assign(canvas.style,{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none',zIndex:'4'})
    const opacity=image ? Number.parseFloat(getComputedStyle(image).opacity) : 1
    canvas.style.opacity=String(Number.isFinite(opacity) ? opacity : 1)
    canvas.addEventListener('webglcontextlost',contextLost)
    const draw=() => {
      if (options.mode==='generation' && opacity<1) canvas.style.opacity=String(opacity+(1-opacity)*Math.min(1,elapsed/2.45))
      gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform1f(timeUniform,elapsed); gl.uniform1f(progressUniform,concentration)
      gl.uniform1f(rotationUniform,rotation)
      gl.uniform1f(releaseUniform,releasedAt===null ? -1 : elapsed-releasedAt)
      const fragments=options.mode==='clear' || Boolean(image && elapsed<2.5)
      gl.uniform1f(fragmentsUniform,fragments ? 1 : 0)
      gl.drawArraysInstanced(gl.TRIANGLES,0,6,options.mode==='clear' ? columns*rows : (fragments ? columns*rows : 0)+510)
    }
    draw(); host.append(canvas); started=true
    /* compositor-exempt: bounded instanced texture particles follow shared rAF;
     * after image breakup only 510 ring segments, light points and trails are submitted. */
    stopFrames=registerParticleFrame((_now,deltaMs) => {
      const delta=deltaMs/1000
      elapsed+=delta
      concentration+=(targetProgress-concentration)*(1-Math.exp(-delta/0.32))
      rotation+=delta*(.18+concentration*.34)
      if (options.mode==='clear' && elapsed>=1.85 || releasedAt!==null && elapsed-releasedAt>=.98) { finish(); return }
      if (!handedOff && options.mode==='clear' && elapsed>=1.1) { handedOff=true; options.onHandoff?.() }
      draw()
    })
    return {
      progress(value) { if (value!==null && Number.isFinite(value)) targetProgress=Math.max(0,Math.min(1,value)) },
      release() { if (releasedAt===null) releasedAt=elapsed },
      refreshPalette,
      stop:finish,
    }
  } catch { finish(); return null }
}
