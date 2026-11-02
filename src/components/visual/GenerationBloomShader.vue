<template><canvas ref="canvas" class="generation-bloom" aria-hidden="true"></canvas></template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useEventListener, useResizeObserver } from '@vueuse/core'
import { registerParticleFrame } from '@/utils/particleScheduler'
import { smoothGenerationPhase } from '@/utils/generationOrbit'

const props = defineProps<{ progress: number | null; colors: readonly string[]; present: boolean; animate: boolean }>()
const emit = defineEmits<{ ready: []; unavailable: [] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
let gl: WebGL2RenderingContext | null = null
let program: WebGLProgram | null = null
let buffer: WebGLBuffer | null = null
let stopFrames: (() => void) | null = null
let time = 1.5, concentration = props.progress ?? 0
let width = 0, height = 0
let uniforms: Record<string, WebGLUniformLocation | null> = {}
const ribbonPhases = new Float32Array(12)

const vertex = `#version 300 es
in vec2 position;
out vec2 uv;
uniform vec2 clipExtent;
void main(){ vec2 point=position*clipExtent; uv=point*.5+.5; gl_Position=vec4(point,0.,1.); }`
const fragment = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outputColor;
uniform float aspect;
uniform vec3 shape;
uniform vec2 laneTilt[3];
uniform vec4 ribbonPhase[3];
uniform vec3 pigmentA, pigmentB, pigmentC;
void main(){
  vec2 p=(uv-.5)*vec2(aspect,1.);
  vec3 light=vec3(0.); float weight=0.;
  for(int lane=0;lane<3;lane++){
    float radius=shape.x*(.84+float(lane)*.085);
    vec2 tilt=laneTilt[lane]; vec4 phase=ribbonPhase[lane];
    vec2 q=mat2(tilt.x,tilt.y,-tilt.y,tilt.x)*p;
    vec2 ellipse=q*vec2(1.,shape.y);
    float r=length(ellipse);
    // Angle addition and triple-angle identities preserve the original ribbon
    // without evaluating atan/sin/cos/pow for each pixel of every lane.
    vec2 direction=ellipse/max(r,.00000001);
    float sin3=direction.y*(3.-4.*direction.y*direction.y);
    float cos3=direction.x*(4.*direction.x*direction.x-3.);
    float wave=(sin3*phase.z+cos3*phase.w)*shape.z;
    float distance=r-radius-wave;
    float flow=clamp(.5+.5*dot(direction,vec2(phase.x,-phase.y)),0.,1.);
    float flow2=flow*flow, flow4=flow2*flow2;
    flow=flow4*flow4*flow2;
    float edge=max(fwidth(distance),.0012);
    float thread=(1.-smoothstep(edge*.5,edge*1.8,abs(distance)))*(.12+flow*.72);
    float aura=exp(-distance*distance/.0005)*(.025+flow*.1);
    vec3 pigment=lane==0?pigmentA:(lane==1?pigmentB:pigmentC);
    float energy=thread+aura;
    light+=pigment*energy; weight+=energy;
    // Moving pinpoints make the ribbon direction readable at a small canvas size.
    vec2 head=vec2(phase.x,-phase.y)*radius;
    float spark=exp(-dot(ellipse-head,ellipse-head)/.00011)*.72;
    light+=mix(pigment,vec3(1.),.3)*spark; weight+=spark;
  }
  float alpha=min(.78,weight)*(1.-smoothstep(.37,.46,length(p)));
  outputColor=vec4(light/max(weight,.0001),alpha);
}`

function stop() { stopFrames?.(); stopFrames = null }
function release() {
  stop()
  if (gl) { gl.deleteBuffer(buffer); gl.deleteProgram(program) }
  buffer = null; program = null; uniforms = {}
}
function unavailable() { release(); emit('unavailable') }
function compile(type: number, source: string) {
  const shader = gl!.createShader(type)
  if (!shader) throw new Error('Shader unavailable')
  gl!.shaderSource(shader, source); gl!.compileShader(shader)
  if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
    gl!.deleteShader(shader); throw new Error('Shader compilation failed')
  }
  return shader
}
function draw() {
  if (!props.present || !gl || !program || !canvas.value) return
  gl.useProgram(program)
  const formed = smoothGenerationPhase(.08, .72, concentration), finish = smoothGenerationPhase(.7, .99, concentration)
  gl.uniform3f(uniforms.shape, .29 - formed * .035 - finish * .09, 1.85 + finish * .7, .012 * (1 - finish))
  for (let lane = 0; lane < 3; lane++) {
    const phase = -time * (.24 + lane * .04) + lane * 2.1, wave = time * .32 + lane * 2
    const offset = lane * 4
    ribbonPhases[offset] = Math.cos(phase); ribbonPhases[offset + 1] = Math.sin(phase)
    ribbonPhases[offset + 2] = Math.cos(wave); ribbonPhases[offset + 3] = Math.sin(wave)
  }
  gl.uniform4fv(uniforms['ribbonPhase[0]'], ribbonPhases)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}
function preparePalette() {
  if (!gl || !program) return
  gl.useProgram(program)
  // Pigments change with the theme/palette, not with every animation frame.
  for (const [index, name] of ['pigmentA', 'pigmentB', 'pigmentC'].entries()) {
    const channels = (props.colors[index]?.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number)
    gl.uniform3f(uniforms[name], channels[0] / 255, channels[1] / 255, channels[2] / 255)
  }
}
function resize() {
  const surface = canvas.value
  if (!props.present || !surface || !width || !height) return
  const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(600_000 / (width * height)))
  const pixelWidth = Math.max(1, Math.round(width * ratio)), pixelHeight = Math.max(1, Math.round(height * ratio))
  if (surface.width !== pixelWidth) surface.width = pixelWidth
  if (surface.height !== pixelHeight) surface.height = pixelHeight
  if (gl && program) {
    gl.useProgram(program)
    gl.viewport(0, 0, pixelWidth, pixelHeight)
    const aspect = pixelWidth / pixelHeight
    gl.uniform1f(uniforms.aspect, aspect)
    // The original alpha is exactly zero beyond radius .46. Keep the same
    // pixel grid and feathering while omitting its transparent outer rectangle.
    gl.uniform2f(uniforms.clipExtent, Math.min(1, .92 / aspect), .92)
  }
  draw()
}
function reconcile() {
  stop()
  if (!program || !props.present) return
  // A cached return paints the latest task snapshot without rebuilding GPU objects.
  concentration = props.progress ?? concentration
  resize()
  if (!props.animate) return
  stopFrames = registerParticleFrame((_now, delta) => {
    time += delta / 1000
    if (props.progress !== null) concentration += (props.progress - concentration) * (1 - Math.exp(-delta / 420))
    draw()
  })
}
useResizeObserver(canvas, ([entry]) => {
  if (!entry) return
  width = entry.contentRect.width; height = entry.contentRect.height
  resize()
})
useEventListener(canvas, 'webglcontextlost', event => { event.preventDefault(); unavailable() })
watch([() => props.present, () => props.animate], reconcile, { flush: 'post' })
watch(() => props.progress, progress => {
  if (!props.present || props.animate) return
  concentration = progress ?? concentration
  draw()
})
watch(() => props.colors, () => { preparePalette(); draw() })
onMounted(() => {
  try {
    gl = canvas.value!.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false })
    if (!gl) { unavailable(); return }
    // Synchronous initialization has no device promise that can arrive after unmount.
    const shaders: WebGLShader[] = []
    try {
      shaders.push(compile(gl.VERTEX_SHADER, vertex))
      shaders.push(compile(gl.FRAGMENT_SHADER, fragment))
      program = gl.createProgram()
      if (!program) throw new Error('Program unavailable')
      for (const shader of shaders) gl.attachShader(program, shader)
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Shader link failed')
    } finally { for (const shader of shaders) gl.deleteShader(shader) }
    buffer = gl.createBuffer()
    if (!buffer) throw new Error('Buffer unavailable')
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW)
    gl.useProgram(program)
    const position = gl.getAttribLocation(program, 'position')
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    uniforms = Object.fromEntries(['shape','aspect','clipExtent','laneTilt[0]','ribbonPhase[0]','pigmentA','pigmentB','pigmentC'].map(name => [name, gl!.getUniformLocation(program!, name)]))
    gl.uniform2fv(uniforms['laneTilt[0]'], new Float32Array([Math.cos(-.55), Math.sin(-.55), 1, 0, Math.cos(.55), Math.sin(.55)]))
    preparePalette()
    reconcile(); emit('ready')
  } catch { unavailable() }
})
onBeforeUnmount(() => {
  release()
  gl?.getExtension('WEBGL_lose_context')?.loseContext()
  gl = null
})
</script>

<style scoped>
/* compositor-exempt: local WebGL2 light layer, <=600k pixels, DPR<=2; full-rate shared RAF, bounded visible footprint and per-frame phase uniforms; pauses when inactive. */
.generation-bloom { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
</style>
