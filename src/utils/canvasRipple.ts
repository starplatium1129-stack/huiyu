const MAX_PIXELS = 600_000
const MAX_EDGE = 960

const vertex = `
attribute vec2 position;
varying vec2 uv;
void main() { uv = position * .5 + .5; gl_Position = vec4(position, 0., 1.); }
`
// Original, deliberately small shader: a passing arc of water, not a screen of noise.
const fragment = `
precision mediump float;
uniform sampler2D artwork;
uniform vec2 size;
uniform float phase;
varying vec2 uv;
void main() {
  vec2 p = (uv - vec2(.5, .48)) * vec2(size.x / size.y, 1.);
  float radius = length(p);
  float ring = exp(-pow((radius - (.28 + phase * .5)) / .105, 2.));
  float calm = pow(1. - phase, 1.5);
  // Protect the central portrait. Displacement is at most 1.6 CSS pixels,
  // falling to zero at the image perimeter, so edges never pull inward.
  float portrait = smoothstep(.14, .27, radius);
  float edge = smoothstep(0., .045, min(min(uv.x, 1. - uv.x), min(uv.y, 1. - uv.y)));
  vec2 direction = p / max(radius, .001);
  vec2 shift = direction * sin(radius * 36. - phase * 9.) * ring * calm * portrait * edge * 1.6 / size;
  vec4 color = texture2D(artwork, clamp(uv + shift, vec2(.001), vec2(.999)));
  float light = ring * calm * portrait * edge;
  color.rgb = mix(color.rgb, vec3(dot(color.rgb, vec3(.2126, .7152, .0722))), light * .1);
  color.rgb += light * .105;
  gl_FragColor = vec4(color.rgb, color.a * (.24 + ring * .65) * calm);
}
`

/** Presentation only. The decoded <img> stays visible and owns the full-resolution
 * artwork; the bounded texture never becomes a result, export, or cached image. */
export function startCanvasRipple(image: HTMLImageElement, host: HTMLElement, duration: number): { canvas: HTMLCanvasElement; stop: () => void } | null {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) return null
  const rect = image.getBoundingClientRect(), parent = host.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1 || !Number.isFinite(rect.width * rect.height)) return null
  const fit = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight)
  const width = image.naturalWidth * fit, height = image.naturalHeight * fit
  const scale = Math.min(window.devicePixelRatio || 1, 1.25, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)))
  const canvas = document.createElement('canvas'), sample = document.createElement('canvas')
  canvas.width = sample.width = Math.max(1, Math.floor(width * scale))
  canvas.height = sample.height = Math.max(1, Math.floor(height * scale))
  duration = Number.isFinite(duration) ? Math.max(160, Math.min(600, duration)) : 520
  let gl: WebGLRenderingContext | null = null
  let program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null, texture: WebGLTexture | null = null
  const shaders: WebGLShader[] = []
  let frame: number | null = null, disposed = false
  const stop = () => {
    if (disposed) return
    disposed = true
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    canvas.removeEventListener('webglcontextlost', stop)
    if (gl) {
      gl.deleteTexture(texture); gl.deleteBuffer(buffer); gl.deleteProgram(program)
      shaders.forEach(shader => gl!.deleteShader(shader))
      // A one-shot context has no future owner. Release the driver allocation now.
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    canvas.remove()
    canvas.width = canvas.height = sample.width = sample.height = 0
  }
  try {
    gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' })
    const reader = sample.getContext('2d')
    if (!gl || !reader) { stop(); return null }
    // Only upload a capped snapshot: even an 8K source never allocates an 8K GPU texture.
    reader.drawImage(image, 0, 0, sample.width, sample.height)
    program = gl.createProgram(); buffer = gl.createBuffer(); texture = gl.createTexture()
    if (!program || !buffer || !texture) { stop(); return null }
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type)
      if (!shader) { stop(); return null }
      shaders.push(shader)
      gl.shaderSource(shader, source); gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { stop(); return null }
      gl.attachShader(program, shader)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { stop(); return null }
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'position')
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // Tainted/cross-origin snapshots throw here; keep the already visible original.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sample)
    if (gl.getError() !== gl.NO_ERROR) { stop(); return null }
    sample.width = sample.height = 0
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.uniform2f(gl.getUniformLocation(program, 'size'), width, height)
    gl.uniform1i(gl.getUniformLocation(program, 'artwork'), 0)
    const phase = gl.getUniformLocation(program, 'phase')
    canvas.className = 'cg-water-reveal'
    canvas.setAttribute('aria-hidden', 'true')
    Object.assign(canvas.style, {
      position: 'absolute', pointerEvents: 'none', zIndex: '1',
      left: `${rect.left - parent.left - host.clientLeft + host.scrollLeft + (rect.width - width) / 2}px`,
      top: `${rect.top - parent.top - host.clientTop + host.scrollTop + (rect.height - height) / 2}px`,
      width: `${width}px`, height: `${height}px`,
    })
    canvas.addEventListener('webglcontextlost', stop)
    const start = performance.now()
    let lastPaint = -Infinity, slowFrames = 0
    function render(now: number) {
      if (disposed) return
      frame = null
      const elapsed = Math.max(0, now - start)
      if (elapsed >= duration || document.visibilityState === 'hidden') { stop(); return }
      if (now - lastPaint >= 1000 / 30) {
        if (Number.isFinite(lastPaint) && now - lastPaint > 80) slowFrames += 1
        if (slowFrames >= 2) { stop(); return }
        lastPaint = now
        /* compositor-exempt: refraction needs texture sampling, not DOM transforms.
         * One <=600ms pass, <=0.6MP/960px texture and backing, <=30 paints/sec;
         * no full-size readback, layout writes, idle loop or global lint exemption. */
        try {
          gl!.uniform1f(phase, elapsed / duration)
          gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4)
        } catch { stop(); return }
      }
      frame = requestAnimationFrame(render)
    }
    render(start)
    if (disposed) return null
    host.append(canvas)
    return { canvas, stop }
  } catch { stop(); return null }
}
