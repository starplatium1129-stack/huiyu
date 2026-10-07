<template>
  <div ref="host" class="hero-light-field" aria-hidden="true">
    <canvas ref="canvas"></canvas>
    <span class="light-palette"><i></i><i></i></span>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useEventListener, useResizeObserver } from '@vueuse/core'
import { useVisualActivity } from '@/composables/useVisualActivity'
import { registerParticleFrame } from '@/utils/particleScheduler'

const props = defineProps<{ muse: 'nene' | 'natsume' }>()
const host = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const pointerSurface = computed(() => host.value?.parentElement ?? null)
const { canPresent, canAnimate, lowEffects, appearanceRevision } = useVisualActivity(host)
let gl: WebGL2RenderingContext | null = null
let program: WebGLProgram | null = null
let buffer: WebGLBuffer | null = null
let stopFrames: (() => void) | null = null
let uniforms: Record<string, WebGLUniformLocation | null> = {}
let time = 7, failed = false
let pigments = [[0, 0, 0], [0, 0, 0]]
let targets = pigments.map(color => [...color])
let pointerBounds: DOMRect | null = null
let pointerX = 0, pointerY = 0, targetX = 0, targetY = 0

const vertex = `#version 300 es
in vec2 position;
out vec2 uv;
void main(){ uv=position*.5+.5; gl_Position=vec4(position,0.,1.); }`
const fragment = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outputColor;
uniform float time, aspect;
uniform vec3 pigmentA, pigmentB;
uniform vec2 pointer;
void main(){
  vec2 p=vec2(uv.x*aspect,uv.y);
  vec3 light=vec3(0.); float energy=0.;
  for(int lane=0;lane<5;lane++){
    float band=float(lane);
    float phase=p.x*2.4-time*.18+band*.32+pointer.x*.32;
    float center=.36+sin(phase)*.12+sin(p.x*4.1+time*.12)*.045+band*.028+pointer.y*.035;
    float distance=abs(p.y-center);
    float width=max(fwidth(distance),.0012);
    float thread=1.-smoothstep(.001,.001+width*1.5,distance);
    float silk=exp(-distance*distance/(.0005+band*.00008));
    float glint=pow(.5+.5*sin(p.x*3.-time*.32+band*.85),8.);
    float weight=thread*(.16+glint*.42)+silk*(.08+glint*.08);
    vec3 pigment=mix(pigmentA,pigmentB,band/4.);
    light+=pigment*weight; energy+=weight;
  }
  float fade=smoothstep(0.,.18,uv.x)*(1.-smoothstep(.88,1.,uv.x));
  fade*=smoothstep(.12,.3,uv.y)*(1.-smoothstep(.65,.95,uv.y));
  outputColor=vec4(light/max(energy,.0001),min(energy,.72)*fade);
}`

function stop() { stopFrames?.(); stopFrames = null }
function resetPointer() { pointerBounds = null; targetX = targetY = 0 }
function enterPointer(event: PointerEvent) {
  if (event.pointerType !== 'mouse' || !canAnimate.value || lowEffects.value) return
  pointerBounds = pointerSurface.value?.getBoundingClientRect() ?? null
}
function movePointer(event: PointerEvent) {
  if (!pointerBounds || !canAnimate.value || lowEffects.value) return
  // Bounds are sampled on entry/resize, never on every pointer movement.
  targetX = Math.max(-1, Math.min(1, (event.clientX-pointerBounds.left)/pointerBounds.width*2-1))
  targetY = Math.max(-1, Math.min(1, 1-(event.clientY-pointerBounds.top)/pointerBounds.height*2))
}
function release() {
  stop()
  if (gl) { gl.deleteBuffer(buffer); gl.deleteProgram(program) }
  program = null; buffer = null; uniforms = {}
}
function compile(type: number, source: string) {
  const shader = gl!.createShader(type)
  if (!shader) throw new Error('Light shader unavailable')
  gl!.shaderSource(shader, source); gl!.compileShader(shader)
  if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
    gl!.deleteShader(shader); throw new Error('Light shader compilation failed')
  }
  return shader
}
function initialize() {
  if (program || failed || !canvas.value) return
  try {
    gl = canvas.value.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false })
    if (!gl) { failed = true; return }
    const shaders: WebGLShader[] = []
    try {
      shaders.push(compile(gl.VERTEX_SHADER, vertex))
      shaders.push(compile(gl.FRAGMENT_SHADER, fragment))
      program = gl.createProgram()
      if (!program) throw new Error('Light program unavailable')
      for (const shader of shaders) gl.attachShader(program, shader)
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Light link failed')
    } finally { for (const shader of shaders) gl.deleteShader(shader) }
    buffer = gl.createBuffer()
    if (!buffer) throw new Error('Light buffer unavailable')
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW)
    gl.useProgram(program)
    const position = gl.getAttribLocation(program, 'position')
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    uniforms = Object.fromEntries(['time','aspect','pigmentA','pigmentB','pointer'].map(name => [name, gl!.getUniformLocation(program!, name)]))
  } catch { failed = true; release() }
}
function readPalette() {
  if (!host.value) return
  targets = [...host.value.querySelectorAll<HTMLElement>('.light-palette i')].map(item =>
    (getComputedStyle(item).color.match(/[\d.]+/g) ?? ['0','0','0']).slice(0,3).map(channel => Number(channel)/255))
  if (!program || !canAnimate.value) pigments = targets.map(color => [...color])
}
function draw() {
  if (!gl || !program || !canvas.value) return
  gl.viewport(0,0,canvas.value.width,canvas.value.height)
  gl.useProgram(program)
  gl.uniform1f(uniforms.time,time)
  gl.uniform1f(uniforms.aspect,canvas.value.width/canvas.value.height)
  gl.uniform2f(uniforms.pointer,pointerX,pointerY)
  for (const [index,name] of ['pigmentA','pigmentB'].entries()) {
    gl.uniform3f(uniforms[name],pigments[index][0],pigments[index][1],pigments[index][2])
  }
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4)
}
function resize() {
  if (!canvas.value || !canPresent.value || lowEffects.value) return
  const { width,height } = canvas.value.getBoundingClientRect()
  if (!width || !height) return
  if (pointerBounds) pointerBounds = pointerSurface.value?.getBoundingClientRect() ?? null
  // Sharper local light on dense desktop screens, without allocating a 4K viewport texture.
  const ratio = Math.min(window.devicePixelRatio || 1,2,Math.sqrt(600_000/(width*height)))
  const w = Math.max(1,Math.round(width*ratio)), h = Math.max(1,Math.round(height*ratio))
  if (canvas.value.width !== w || canvas.value.height !== h) {
    canvas.value.width = w; canvas.value.height = h
  }
  draw()
}
function reconcile() {
  stop()
  if (!canPresent.value || lowEffects.value) { resetPointer(); pointerX = pointerY = 0 }
  if (lowEffects.value) {
    release()
    if (gl && canvas.value) gl.clear(gl.COLOR_BUFFER_BIT)
    return
  }
  if (!canPresent.value) return
  readPalette(); initialize(); resize()
  if (!program || !canAnimate.value) return
  stopFrames = registerParticleFrame((_now,delta) => {
    time += delta/1000
    const blend = 1-Math.exp(-delta/240)
    for (let color=0;color<2;color++) for (let channel=0;channel<3;channel++) pigments[color][channel] += (targets[color][channel]-pigments[color][channel])*blend
    const follow = 1-Math.exp(-delta/160)
    pointerX += (targetX-pointerX)*follow; pointerY += (targetY-pointerY)*follow
    draw()
  })
}
useResizeObserver(host,resize)
useEventListener(pointerSurface,'pointerenter',enterPointer,{ passive:true })
useEventListener(pointerSurface,'pointermove',movePointer,{ passive:true })
useEventListener(pointerSurface,'pointerleave',resetPointer,{ passive:true })
useEventListener(window,'scroll',resetPointer,{ passive:true })
useEventListener(canvas,'webglcontextlost',event => { event.preventDefault(); failed = true; release() })
useEventListener(canvas,'webglcontextrestored',() => { failed = false; reconcile() })
watch([canPresent,canAnimate,lowEffects],reconcile,{ flush:'post' })
watch([appearanceRevision,() => props.muse],() => { readPalette(); if (canPresent.value && !lowEffects.value) draw() },{ flush:'post' })
onBeforeUnmount(() => { release(); gl?.getExtension('WEBGL_lose_context')?.loseContext(); gl = null })
</script>

<style scoped>
/* compositor-exempt: local WebGL silk light, <=600k pixels and DPR<=2; shared display-synced RAF pauses offscreen/hidden/cached. */
.hero-light-field { position:absolute; inset:34% 0 0; pointer-events:none; contain:strict; }
.hero-light-field canvas { display:block; width:100%; height:100%; }
.light-palette { position:absolute; width:0; height:0; overflow:hidden; visibility:hidden; }
.light-palette i:first-child { color:var(--accent); }
.light-palette i:last-child { color:var(--archive-cyan); }
@media (prefers-reduced-transparency:reduce) { .hero-light-field { display:none; } }
</style>
