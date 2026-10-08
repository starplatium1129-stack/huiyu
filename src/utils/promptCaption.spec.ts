import { expect, it } from 'vitest'
import { createPromptPlan, renderPromptPlan } from './promptCompiler'

it('keeps authored Anima relationships while applying accepted visual input and current direction', () => {
  const scene = { animaCaption: 'A close-up of an adult woman holding a book in window light' }
  const plan = createPromptPlan({ identity: '1girl, black_hair', scene,
    camera: ['wide shot'], lighting: ['moonlight'], visualDescription: 'A red bookmark rests between the pages.' })
  const before = JSON.stringify(plan)
  const caption = renderPromptPlan(plan, 'anima').prompt.split('\n')[1]
  expect(caption).toContain('holding a book')
  expect(caption).toContain('A wide shot')
  expect(caption).toContain('moonlight')
  expect(caption).not.toMatch(/close-up|window light/)
  expect(caption).toContain('A red bookmark rests between the pages.')
  expect(JSON.stringify(plan)).toBe(before)
})

it('adds missing directions without replacing props, and restores the authored caption when controls clear', () => {
  const scene = { animaCaption: 'She holds a lantern beside an open book' }
  const render = (input = {}) => renderPromptPlan(createPromptPlan({ identity: '1girl', scene, ...input }), 'anima').prompt.split('\n')[1]
  expect(render({ camera: ['close_up'], lighting: ['moonlight'] })).toMatch(/holds a lantern.*Frame it with a close-up.*moonlight/)
  expect(render()).toBe(`${scene.animaCaption}.`)
  expect(render({ visualDescription: '书页上的红色书签' })).toBe(render())
  expect(render({ visualDescription: scene.animaCaption })).toBe(render())
})
