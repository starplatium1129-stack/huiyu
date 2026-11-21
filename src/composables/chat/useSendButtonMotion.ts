// Lucian UX/UI Prompt #005 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#005
import { nextTick, onActivated, onDeactivated, onScopeDispose, ref, watch } from 'vue'
import { useMotionPreference } from '@/composables/useMotionPreference'

type Point = [number, number]
const curves: [Point, Point, Point, Point][] = [
  [[0,0],[-30,-60],[-150,-70],[-150,-140]],
  [[-150,-140],[-150,-205],[-70,-215],[-60,-165]],
  [[-60,-165],[-50,-120],[-125,-110],[-120,-170]],
  [[-120,-170],[-115,-235],[-10,-280],[90,-330]],
]
function flightFrames(): Keyframe[] {
  const points = curves.flatMap(([a,b,c,d], segment) => Array.from({ length:25 }, (_, index) => {
    const t = index / 24, s = 1 - t
    const x = s*s*s*a[0]+3*s*s*t*b[0]+3*s*t*t*c[0]+t*t*t*d[0]
    const y = s*s*s*a[1]+3*s*s*t*b[1]+3*s*t*t*c[1]+t*t*t*d[1]
    const dx = 3*s*s*(b[0]-a[0])+6*s*t*(c[0]-b[0])+3*t*t*(d[0]-c[0])
    const dy = 3*s*s*(b[1]-a[1])+6*s*t*(c[1]-b[1])+3*t*t*(d[1]-c[1])
    return { x,y,angle:Math.atan2(dy,dx)*180/Math.PI+45, segment,index }
  })).filter(point => point.segment === 0 || point.index > 0)
  let length = 0
  const distances = points.map((point,index) => {
    if (index) length += Math.hypot(point.x-points[index-1].x, point.y-points[index-1].y)
    return length
  })
  return points.map((point,index) => {
    const offset = distances[index]/length
    const scale = offset < .35 ? .75 + offset/.35*.5 : 1.25 - (offset-.35)/.65*.55
    return { offset, transform:`translate(${point.x}px,${point.y}px) rotate(${point.angle}deg) scale(${scale})`, opacity:index === points.length-1 ? 0 : 1 }
  })
}

export function useSendButtonMotion(options: {
  busy: () => boolean; turnId: () => string; completed: () => boolean; context: () => string
  messageHost: () => HTMLElement | null | undefined
}) {
  const reduced = useMotionPreference(), plane = ref<HTMLElement | null>(null)
  const flying = ref(false), feedback = ref<'idle'|'done'|'back'>('idle')
  let active = true, revision = 0, flightId = ''
  let animations: Animation[] = []
  let flightTimer: ReturnType<typeof setTimeout> | undefined, resetTimer: ReturnType<typeof setTimeout> | undefined
  function stop() {
    revision++; clearTimeout(flightTimer); clearTimeout(resetTimer)
    for (const animation of animations) animation.cancel()
    animations = []; flying.value = false; feedback.value = 'idle'
  }
  watch(options.turnId, async (id, previous) => {
    if (!id || id === previous || !options.busy() || !active) return
    stop(); flightId = id
    if (reduced.value || document.hidden) return
    const request = revision
    await nextTick()
    if (!active || request !== revision || !plane.value || reduced.value) return
    flying.value = true
    animations.push(plane.value.animate(flightFrames(), { duration:1500, easing:'cubic-bezier(.45,0,.3,1)', fill:'both' }))
    const bubble = [...(options.messageHost()?.querySelectorAll<HTMLElement>('[data-mid]') ?? [])].find(element => element.dataset.mid === id)
    if (bubble) animations.push(bubble.animate([
      { opacity:0, transform:'translate(10px,18px) scale(.6)', transformOrigin:'100% 100%' },
      { opacity:1, transform:'none', transformOrigin:'100% 100%' },
    ], { duration:500, easing:'cubic-bezier(.3,1.5,.5,1)' }))
    flightTimer = setTimeout(() => {
      if (request !== revision) return
      flying.value = false
      for (const animation of animations) animation.cancel()
      animations = []
    }, 1580)
  })
  watch(options.busy, busy => {
    if (busy || !flightId) return
    const confirmed = options.completed() && flightId === options.turnId()
    stop(); flightId = ''
    if (confirmed) {
      feedback.value = 'done'
      resetTimer = setTimeout(() => {
        feedback.value = 'back'
        resetTimer = setTimeout(() => { feedback.value = 'idle' }, 600)
      }, 900)
    }
  })
  watch(options.context, () => { stop(); flightId = '' })
  watch(reduced, value => { if (value) stop() })
  function visibility() { if (document.hidden) stop() }
  function activate() { active = true; document.addEventListener('visibilitychange', visibility) }
  function deactivate() { active = false; stop(); flightId = ''; document.removeEventListener('visibilitychange', visibility) }
  onActivated(activate)
  // This component may also be used outside a cached route.
  document.addEventListener('visibilitychange', visibility)
  onDeactivated(deactivate)
  onScopeDispose(deactivate)
  return { plane, flying, feedback, reduced }
}
