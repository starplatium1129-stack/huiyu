/** Original WebGL2 texture-particle implementation; Telegram-inspired dust motion,
 * independently written. Image particles meet the fine-line waiting surface at both ends. */
import { registerParticleFrame } from './particleScheduler'
import { sampleGenerationPalette, visibleGenerationPigment } from './generationPalette'
import { generationOrbitPose, smoothGenerationPhase, type GenerationOrbitSurface } from './generationOrbit'

export interface CanvasParticleReveal { stop: () => void; finished: Promise<void>; resize?: () => void }
export interface CanvasParticleMotion {
  stop: () => void
  resize: () => void
  reveal: (image: HTMLImageElement, duration: number, palette: readonly string[]) => CanvasParticleReveal | null
}
interface Options {
  generation?: { progress: () => number | null; palette: readonly string[]; orbit: () => GenerationOrbitSurface | null }
  onComplete?: () => void
  onHandoff?: () => void
}
const VERTEX = `#version 300 es
precision highp float;
uniform vec2 viewport;
uniform vec4 imageRect;
uniform vec2 orbitCenter;
uniform float dustTime;
uniform float clearing;
uniform float revealProgress;
uniform vec4 departureRect;
uniform float departureDust;
uniform vec4 orbitShape;
uniform float orbitRotation;
uniform float orbitOpacity;
out vec2 uv;
out vec2 local;
out vec2 pixelPosition;
out float mixColor;
out float alpha;
out float rounding;
flat out int band;
float hash(float n){return fract(sin(n*127.13+19.7)*43758.5453);}
void waitingPose(vec4 rect,float dust,out vec2 position,out vec2 dimensions,out float opacity,out float pigment,out float rounded,out float orientation){
 vec2 grid=vec2(132,192);
 float id=float(gl_InstanceID),seed=hash(id),lane=mod(id,3.0);
 vec2 cell=vec2(mod(id,grid.x),floor(id/grid.x));
 vec2 source=rect.xy+(cell+.5)/grid*rect.zw;
 // Same geometry as generationOrbitPoint: the visible fine lines own the wait.
 float formed=orbitShape.y,finishing=orbitShape.z;
 float angle=floor(id/3.0)/(132.0*192.0/3.0)*6.2831853+orbitRotation*(lane==1.0?-1.6:1.85)+lane*1.64;
 float tilt=(-.64+lane*.61)*(1.0-finishing*.75)+sin(orbitShape.w*.17+lane)*.075*(1.0-finishing);
 float radius=orbitShape.x*(.86+lane*.08);
 float flatten=.31+lane*.035+formed*.1-finishing*.2;
 vec2 orbit=vec2(cos(angle)*radius,sin(angle)*radius*flatten+sin(angle*2.0+orbitShape.w*.12)*2.5*(1.0-finishing));
 orbit=vec2(orbit.x*cos(tilt)-orbit.y*sin(tilt),orbit.x*sin(tilt)+orbit.y*cos(tilt));
 vec2 destination=orbitCenter.xy+orbit;
 position=destination;
 // Adjacent image cells meet edge-to-edge as a continuous one-pixel thread,
 // matching the waiting canvas instead of fading into an invisible dust ring.
 vec2 tangent=vec2(-sin(angle)*radius,cos(angle)*radius*flatten+cos(angle*2.0+orbitShape.w*.12)*5.0*(1.0-finishing));
 float threadAngle=atan(tangent.y,tangent.x)+tilt;
 vec2 ringSize=vec2(length(tangent)*6.2831853/(132.0*192.0/3.0)*1.08,1.0);
 float ringAlpha=(.32+finishing*.08)*orbitOpacity;
 dimensions=ringSize; opacity=ringAlpha; pigment=1.0; rounded=0.0; orientation=threadAngle;
 if(dust>=0.0){
  float delay=(cell.x/grid.x)*.30+(cell.y/grid.y)*.07+seed*.11;
  float age=max(0.0,dust-delay), grain=smoothstep(.015,.42,age);
  float flight=max(0.0,age-.025), drift=flight*(1.0-exp(-flight*6.0));
  vec2 wind=vec2(34.0+seed*49.0,-8.0-hash(id+7.0)*17.0);
  vec2 flutter=vec2(sin(seed*21.0+flight*3.0),cos(seed*17.0+flight*2.2)*.5)*flight*flight*8.0;
  vec2 blown=source+wind*drift+flutter;
  vec2 dustSize=mix(rect.zw/grid*1.003,vec2(.65+seed*.7),grain);
  float dustAlpha=1.0-smoothstep(.60+seed*.16,1.75+seed*.16,age);
  float join=clearing>.5?0.0:smoothstep(.55,2.0,dust);
  vec2 offset=blown-orbitCenter.xy;
  position=mix(blown,destination,join)+vec2(-offset.y,offset.x)*sin(join*3.14159)*.20;
  dimensions=mix(dustSize,ringSize,join);opacity=mix(dustAlpha,ringAlpha,join);
  pigment=join*join;rounded=grain*(1.0-join);orientation=threadAngle*join;
 }
}
void main(){
 vec2 corners[6]=vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
 vec2 corner=corners[gl_VertexID],grid=vec2(132,192);
 float id=float(gl_InstanceID),seed=hash(id);band=int(mod(id,3.0));
 vec2 cell=vec2(mod(id,grid.x),floor(id/grid.x));uv=(cell+corner)/grid;local=corner*2.0-1.0;
 vec2 position,dimensions;float orientation;
 if(revealProgress>=0.0){
  waitingPose(departureRect,departureDust,position,dimensions,alpha,mixColor,rounding,orientation);
  float t=clamp(revealProgress,0.0,1.0);
  float delay=length((cell+.5)/grid-.5)*.113+seed*.04;
  float formation=clamp((t-delay)/(.88-delay),0.0,1.0);
  float arrival=formation*formation*formation*(formation*(formation*6.0-15.0)+10.0);
  vec2 target=imageRect.xy+(cell+.5)/grid*imageRect.zw;
  vec2 offset=position-target;
  position=mix(position,target,arrival)+vec2(-offset.y,offset.x)*sin(arrival*3.14159)*.08;
  dimensions=mix(dimensions,imageRect.zw/grid*1.003,arrival);
  alpha=mix(alpha,1.0,arrival);
  mixColor*=1.0-smoothstep(.08,.82,arrival);
  rounding=max(rounding*(1.0-smoothstep(.3,1.0,arrival)),sin(arrival*3.14159)*.9);
  orientation*=1.0-arrival;
 }else waitingPose(imageRect,dustTime,position,dimensions,alpha,mixColor,rounding,orientation);
 vec2 offset=(corner-.5)*dimensions;
 position+=vec2(offset.x*cos(orientation)-offset.y*sin(orientation),offset.x*sin(orientation)+offset.y*cos(orientation));
 pixelPosition=position;
 gl_Position=vec4(position/viewport*vec2(2.0,-2.0)+vec2(-1.0,1.0),0,1);
}`
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D artwork;
uniform sampler2D resultArtwork;
uniform vec3 pigments[3];
uniform vec3 resultPigments[3];
uniform float light;
uniform float revealProgress;
uniform vec4 imageRect;
uniform float imageRadius;
in vec2 uv;
in vec2 local;
in vec2 pixelPosition;
in float mixColor;
in float alpha;
in float rounding;
flat in int band;
out vec4 color;
void main(){
 float takeover=smoothstep(0.0,.22,max(0.0,revealProgress));
 vec4 texel=texture(artwork,uv);
 if(revealProgress>=0.0)texel=mix(texel,texture(resultArtwork,uv),takeover);
 float luminance=dot(texel.rgb,vec3(.2126,.7152,.0722));
 vec3 ink=texel.rgb*min(1.0,.42/max(luminance,.001));
 vec3 textureColor=mix(texel.rgb,ink,light*rounding);
 float coverage=mix(alpha,pow(max(alpha,0.0),.76),light*rounding);
 float mask=mix(1.0,1.0-smoothstep(.62,1.0,length(local)),rounding);
 if(revealProgress>=0.0){
  vec2 halfSize=imageRect.zw*.5;
  vec2 corner=abs(pixelPosition-imageRect.xy-halfSize)-(halfSize-vec2(imageRadius));
  float edge=length(max(corner,vec2(0)))+min(max(corner.x,corner.y),0.0)-imageRadius;
  mask*=mix(1.0,1.0-smoothstep(-.5,.5,edge),smoothstep(.7,.88,revealProgress));
 }
 vec3 pigment=mix(pigments[band],resultPigments[band],takeover);
 color=vec4(mix(textureColor,pigment,mixColor),texel.a*coverage*mask);
}`

/** Normal motion follows every display RAF, with bounded texture and backing sizes.
 * A null source starts the same orbit on an empty canvas. */
export function startCanvasTextureParticles(image: HTMLImageElement | null, host: HTMLElement, options: Options): CanvasParticleMotion | null {
  let bounds = host.getBoundingClientRect()
  if (!(bounds.width > 0 && bounds.height > 0)) return null
  if (image && (!image.complete || !image.naturalWidth || !image.naturalHeight)) return null
  if (!image && !options.generation) return null
  const canvas = document.createElement('canvas')
  function sizeBacking() {
    const scale = Math.min(window.devicePixelRatio || 1, 1.6, 1440 / Math.max(bounds.width, bounds.height), Math.sqrt(900_000 / (bounds.width * bounds.height)))
    canvas.width = Math.max(1, Math.floor(bounds.width * scale)); canvas.height = Math.max(1, Math.floor(bounds.height * scale))
  }
  sizeBacking()
  let gl: WebGL2RenderingContext | null
  try { gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'low-power' }) }
  catch { return null }
  if (!gl) return null
  const shaders: WebGLShader[] = []
  let program: WebGLProgram | null = null, texture: WebGLTexture | null = null, resultTexture: WebGLTexture | null = null, vao: WebGLVertexArrayObject | null = null
  let stopFrames: (() => void) | null = null
  let disposed = false, started = false, handedOff = false, elapsed = 0
  let revealElapsed: number | null = null
  let revealDuration = 0, revealStartedAt = 0
  let resolveReveal: (() => void) | null = null
  let restoreImage: (() => void) | null = null, resultOpacity = 1
  let revealEffect: CanvasParticleReveal | null = null
  let departureRect: number[] | null = null, departureOpacity = 1
  let resultImage: HTMLImageElement | null = null
  let waitingCleared = false
  const finish = () => {
    if (disposed) return
    disposed = true
    stopFrames?.(); stopFrames = null
    options.generation?.orbit()?.setOpacity(1)
    restoreImage?.(); restoreImage = null
    resolveReveal?.(); resolveReveal = null
    canvas.removeEventListener('webglcontextlost', contextLost)
    gl.deleteTexture(texture); gl.deleteTexture(resultTexture); gl.deleteVertexArray(vao); gl.deleteProgram(program)
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
    const imageUniform = uniform('imageRect'), revealUniform = uniform('revealProgress'), dustUniform = uniform('dustTime'), lightUniform = uniform('light')
    const orbitShapeUniform = uniform('orbitShape'), orbitRotationUniform = uniform('orbitRotation'), orbitOpacityUniform = uniform('orbitOpacity')
    const pigmentUniforms = [0, 1, 2].map(band => uniform(`pigments[${band}]`))
    const resultPigmentUniforms = [0, 1, 2].map(band => uniform(`resultPigments[${band}]`))
    let imageRect = [0, 0, bounds.width, bounds.height]
    function updateImageRect(next: HTMLImageElement) {
      const rect = next.getBoundingClientRect()
      if (!(rect.width > 0 && rect.height > 0)) throw new Error('Image bounds unavailable')
      const fit = Math.min(rect.width / next.naturalWidth, rect.height / next.naturalHeight)
      const width = next.naturalWidth * fit, height = next.naturalHeight * fit
      imageRect = [rect.left - bounds.left - host.clientLeft + (rect.width - width) / 2,
        rect.top - bounds.top - host.clientTop + (rect.height - height) / 2, width, height]
      gl!.uniform4fv(imageUniform, imageRect)
      // Match the final image's rounded frame before the DOM takes over.
      gl!.uniform1f(uniform('imageRadius'), Math.min(Number.parseFloat(getComputedStyle(next).borderTopLeftRadius) || 0, width / 2, height / 2))
    }
    function capture(next: HTMLImageElement) {
      const snapshot = document.createElement('canvas')
      const ratio = Math.min(1, 1280 / Math.max(next.naturalWidth, next.naturalHeight), Math.sqrt(800_000 / (next.naturalWidth * next.naturalHeight)))
      snapshot.width = Math.max(1, Math.floor(next.naturalWidth * ratio)); snapshot.height = Math.max(1, Math.floor(next.naturalHeight * ratio))
      try {
        const paint = snapshot.getContext('2d')
        if (!paint) throw new Error('Snapshot unavailable')
        paint.drawImage(next, 0, 0, snapshot.width, snapshot.height)
        gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, snapshot)
      } finally { snapshot.width = snapshot.height = 0 }
      updateImageRect(next)
    }
    if (image) capture(image)
    else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
      gl.uniform4f(imageUniform, 0, 0, bounds.width, bounds.height)
    }
    const palette = options.generation?.palette.length === 3 ? [...options.generation.palette] : image ? sampleGenerationPalette(image) : []
    let resultPalette = [...palette]
    const themeRoot = host.closest<HTMLElement>('[data-theme]') ?? document.documentElement
    let lastTheme: boolean | undefined
    const appearance = () => {
      const light = themeRoot.dataset.theme === 'light'
      if (lastTheme === light) return
      lastTheme = light
      for (let band = 0; band < 3; band++) {
        const color = visibleGenerationPigment(palette[band] ?? '170 125 150', light).split(' ').map(Number)
        gl.uniform3f(pigmentUniforms[band], color[0] / 255, color[1] / 255, color[2] / 255)
        const resultColor = visibleGenerationPigment(resultPalette[band] ?? '170 125 150', light).split(' ').map(Number)
        gl.uniform3f(resultPigmentUniforms[band], resultColor[0] / 255, resultColor[1] / 255, resultColor[2] / 255)
      }
      gl.uniform1f(lightUniform, light ? 1 : 0)
    }
    gl.uniform2f(uniform('viewport'), bounds.width, bounds.height)
    gl.uniform2f(uniform('orbitCenter'), bounds.width / 2, bounds.height * .43)
    gl.uniform1f(uniform('clearing'), options.generation ? 0 : 1)
    gl.uniform1i(uniform('artwork'), 0); gl.uniform1i(uniform('resultArtwork'), 0)
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.viewport(0, 0, canvas.width, canvas.height)
    canvas.className = 'canvas-texture-particles'; canvas.dataset.mode = options.generation ? 'generation' : 'clear'; canvas.setAttribute('aria-hidden', 'true')
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '4' })
    const dustTime = () => !options.generation || (image && elapsed < 2) ? elapsed : -1
    const orbitPose = () => {
      const pose = options.generation?.orbit()?.snapshot()
      if (pose?.radius) return pose
      const width = Math.min(bounds.width, 480), height = Math.min(width / 1.38, bounds.height * .86)
      return generationOrbitPose(width, height, options.generation?.progress() ?? 0, 1.5, .27)
    }
    const waitingOpacity = () => image ? smoothGenerationPhase(1.5, 2, elapsed) : 1
    const draw = () => {
      const reveal = revealElapsed === null ? -1 : revealElapsed / revealDuration
      // Keep the orbit-to-image formation, then crossfade to the decoded original
      // before the sampled particles become a complete low-resolution surface.
      if (reveal >= 0 && resultImage) {
        const handoff = smoothGenerationPhase(.55, .8, reveal)
        resultImage.style.opacity = String(resultOpacity * handoff)
        canvas.style.opacity = String(1 - handoff)
      }
      const orbitOpacity = reveal < 0 ? waitingOpacity() : departureOpacity * (1 - smoothGenerationPhase(0, .4, reveal))
      options.generation?.orbit()?.setOpacity(orbitOpacity)
      // No invisible particle field is painted during the wait: the original
      // Canvas lines, pinpoints and local bloom remain the only waiting visual.
      if (options.generation && reveal < 0 && dustTime() < 0) {
        if (!waitingCleared) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); waitingCleared = true }
        return
      }
      appearance(); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
      // Both surfaces follow the live pose through departure and arrival;
      // freezing only the texture field makes their overlapping curves diverge.
      const pose = orbitPose()
      gl.uniform4f(orbitShapeUniform, pose.radius, pose.formed, pose.finishing, pose.time)
      gl.uniform1f(orbitRotationUniform, pose.rotation)
      gl.uniform1f(orbitOpacityUniform, 1 - orbitOpacity)
      gl.uniform1f(revealUniform, reveal)
      gl.uniform1f(dustUniform, dustTime())
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 132 * 192)
    }
    function resize() {
      if (disposed) return
      try {
        const next = host.getBoundingClientRect(), previous = bounds
        if (!(next.width > 0 && next.height > 0)) return
        const changed = Math.abs(next.width - previous.width) >= .5 || Math.abs(next.height - previous.height) >= .5
        bounds = next
        if (changed) {
          const scale = Math.min(next.width / previous.width, next.height / previous.height)
          const fitRect = (rect: number[]) => [next.width / 2 + (rect[0] - previous.width / 2) * scale,
            next.height / 2 + (rect[1] - previous.height / 2) * scale, rect[2] * scale, rect[3] * scale]
          sizeBacking()
          gl!.uniform2f(uniform('viewport'), next.width, next.height)
          gl!.uniform2f(uniform('orbitCenter'), next.width / 2, next.height * .43)
          if (!resultImage) { imageRect = fitRect(imageRect); gl!.uniform4fv(imageUniform, imageRect) }
          if (departureRect) { departureRect = fitRect(departureRect); gl!.uniform4fv(uniform('departureRect'), departureRect) }
          gl!.viewport(0, 0, canvas.width, canvas.height)
        }
        // The artwork frame can resize inside an unchanged viewport too.
        if (resultImage) updateImageRect(resultImage)
        draw()
      } catch { finish() }
    }
    canvas.addEventListener('webglcontextlost', contextLost)
    draw(); host.append(canvas); started = true
    /* compositor-exempt: bounded instanced particles share the display RAF; no FPS cap, per-frame texture upload or CPU particle loop. */
    stopFrames = registerParticleFrame((now, deltaMs) => {
      elapsed += deltaMs / 1000
      try {
        if (revealElapsed !== null) {
          revealElapsed = Math.max(0, now - revealStartedAt) / 1000
          if (revealElapsed >= revealDuration) { finish(); return }
        }
        if (!options.generation) {
          if (elapsed >= 2.4) { finish(); return }
          if (!handedOff && elapsed >= 1.65) { handedOff = true; options.onHandoff?.() }
        }
        draw()
      } catch { finish() }
    })
    return {
      stop: finish,
      resize,
      reveal(next, duration, nextPalette) {
        if (disposed || !options.generation || !next.complete || !next.naturalWidth || !next.naturalHeight) return null
        if (revealEffect) return revealEffect
        revealEffect = { stop: finish, resize, finished: new Promise<void>(resolve => { resolveReveal = resolve }) }
        try {
          // Preserve the current dust/orbit pose, including a result arriving before 2s.
          departureRect = [...imageRect]; departureOpacity = waitingOpacity()
          gl.uniform4fv(uniform('departureRect'), departureRect)
          gl.uniform1f(uniform('departureDust'), dustTime())
          resultTexture = gl.createTexture()
          if (!resultTexture) throw new Error('Result texture unavailable')
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, resultTexture)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
          resultImage = next; capture(next); gl.uniform1i(uniform('resultArtwork'), 1)
          resultPalette = nextPalette.length === 3 ? [...nextPalette] : [...palette]; lastTheme = undefined
          revealDuration = duration / 1000; revealElapsed = 0; canvas.dataset.mode = 'reveal'
          const opacity = next.style.opacity
          const computedOpacity = Number.parseFloat(getComputedStyle(next).opacity)
          resultOpacity = Number.isFinite(computedOpacity) ? computedOpacity : 1
          restoreImage = () => { next.style.opacity = opacity }
          draw()
          revealStartedAt = performance.now()
        }
        catch { finish(); return null }
        return revealEffect
      },
    }
  } catch { finish(); return null }
}
