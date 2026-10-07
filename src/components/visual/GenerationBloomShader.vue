<template><canvas ref="canvas" class="generation-bloom" aria-hidden="true"></canvas></template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useEventListener, useResizeObserver } from '@vueuse/core'
import { registerParticleFrame } from '@/utils/particleScheduler'

const props = defineProps<{ progress: number | null; colors: readonly string[]; present: boolean; animate: boolean }>()
const emit = defineEmits<{ ready: []; unavailable: [] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
let gl: WebGL2RenderingContext | null = null
let program: WebGLProgram | null = null
let buffer: WebGLBuffer | null = null
let stopFrames: (() => void) | null = null
let time = 1.5, concentration = props.progress ?? 0
let uniforms: Record<string, WebGLUniformLocation | null> = {}

const vertex = `#version 300 es
in vec2 position;
out vec2 uv;
void main(){ uv=position*.5+.5; gl_Position=vec4(position,0.,1.); }`
const fragment = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outputColor;
uniform float time, gather, aspect;
uniform vec3 pigmentA, pigmentB, pigmentC;
void main(){
  vec2 p=(uv-.5)*vec2(aspect,1.);
  float formed=smoothstep(.08,.72,gather), finish=smoothstep(.7,.99,gather);
  float radius=.29-formed*.035-finish*.09;
  vec3 light=vec3(0.); float weight=0.;
  for(int lane=0;lane<3;lane++){
    float b=float(lane), tilt=-.55+b*.55;
    vec2 q=mat2(cos(tilt),sin(tilt),-sin(tilt),cos(tilt))*p;
    vec2 ellipse=q*vec2(1.,1.85+finish*.7);
    float angle=atan(ellipse.y,ellipse.x), r=length(ellipse);
    float wave=sin(angle*3.+time*.32+b*2.)*.012*(1.-finish);
    float distance=r-radius*(.84+b*.085)-wave;
    float phase=angle-time*(.24+b*.04)+b*2.1;
    float flow=pow(.5+.5*cos(phase),10.);
    float edge=max(fwidth(distance),.0012);
    float thread=(1.-smoothstep(edge*.5,edge*1.8,abs(distance)))*(.12+flow*.72);
    float aura=exp(-distance*distance/.0005)*(.025+flow*.1);
    vec3 pigment=lane==0?pigmentA:(lane==1?pigmentB:pigmentC);
    float energy=thread+aura;
    light+=pigment*energy; weight+=energy;
    // Moving pinpoints make the ribbon direction readable at a small canvas size.
    vec2 head=vec2(cos(time*(.24+b*.04)-b*2.1),sin(time*(.24+b*.04)-b*2.1))*radius*(.84+b*.085);
    float spark=exp(-dot(ellipse-head,ellipse-head)/.00011)*.72;
    light+=mix(pigment,vec3(1.),.3)*spark; weight+=spark;
  }
  float core=exp(-dot(p,p)/(.007-finish*.003))*(.16+finish*.32);
  float mist=exp(-dot(p,p)/.032)*(.035+formed*.025)*(1.-finish*.4);
  light+=mix(pigmentA,pigmentC,.5)*(core+mist); weight+=core+mist;
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
  gl.viewport(0, 0, canvas.value.width, canvas.value.height)
  gl.useProgram(program)
  gl.uniform1f(uniforms.time, time); gl.uniform1f(uniforms.gather, concentration)
  gl.uniform1f(uniforms.aspect, canvas.value.width / canvas.value.height)
  for (const [index, name] of ['pigmentA', 'pigmentB', 'pigmentC'].entries()) {
    const channels = (props.colors[index]?.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number)
    gl.uniform3f(uniforms[name], channels[0] / 255, channels[1] / 255, channels[2] / 255)
  }
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}
function resize() {
  const surface = canvas.value
  if (!props.present || !surface) return
  const { width, height } = surface.getBoundingClientRect()
  if (!width || !height) return
  const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(600_000 / (width * height)))
  const pixelWidth = Math.max(1, Math.round(width * ratio)), pixelHeight = Math.max(1, Math.round(height * ratio))
  if (surface.width !== pixelWidth) surface.width = pixelWidth
  if (surface.height !== pixelHeight) surface.height = pixelHeight
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
useResizeObserver(canvas, resize)
useEventListener(canvas, 'webglcontextlost', event => { event.preventDefault(); unavailable() })
watch([() => props.present, () => props.animate], reconcile, { flush: 'post' })
watch(() => props.progress, progress => {
  if (!props.present || props.animate) return
  concentration = progress ?? concentration
  draw()
})
watch(() => props.colors, draw)
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
    uniforms = Object.fromEntries(['time','gather','aspect','pigmentA','pigmentB','pigmentC'].map(name => [name, gl!.getUniformLocation(program!, name)]))
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
/* compositor-exempt: local WebGL2 light layer, <=600k pixels, DPR<=2; follows shared RAF and pauses when inactive. */
.generation-bloom { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
</style>
