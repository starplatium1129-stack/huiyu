import { describe, expect, it } from 'vitest'
import { FluidSpring } from './fluidSpring'

describe('continuous UI spring', () => {
  it('preserves momentum when the user reverses direction', () => {
    const spring = new FluidSpring(0)
    spring.to(100); spring.step(.04)
    const position = spring.value, velocity = spring.velocity
    spring.to(0)
    expect(spring.value).toBe(position)
    expect(spring.velocity).toBe(velocity)
    spring.step(.001)
    expect(spring.value).toBeGreaterThan(position)
    for (let i = 0; i < 120; i++) spring.step(1 / 60)
    expect(spring.value).toBe(0)
    expect(spring.settled).toBe(true)
  })
  it('follows the same path at 60 Hz, 120 Hz and after a missed frame', () => {
    const simulate = (steps: number[]) => {
      const spring = new FluidSpring(0); spring.to(100)
      steps.forEach(dt => spring.step(dt)); return spring.value
    }
    expect(simulate(Array(12).fill(1 / 60))).toBeCloseTo(simulate(Array(24).fill(1 / 120)), 9)
    expect(simulate([.2])).toBeCloseTo(simulate(Array(12).fill(1 / 60)), 9)
  })
  it('snaps to the newest intention for reduced motion', () => {
    const spring = new FluidSpring(0)
    spring.to(100); spring.step(.03); spring.to(25); spring.snap()
    expect(spring.value).toBe(25); expect(spring.velocity).toBe(0)
  })
})
