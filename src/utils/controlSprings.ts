/** Interaction tuning adapted from Caho1/open-claude-ui, MIT © 2026 Caho1.
 * Source: 638800b8a4cee4513c8763c3df0ecf8a77b32379/code-examples/ClaudeMotionPresets.ts
 * License: assets/licenses/open-claude-ui.txt. */
/** Silky classic-iOS surface glide: instant start, unhurried damped settle; input never waits. */
const SURFACE_SPRING = { stiffness: 300, damping: 28, mass: 1 } as const
export const SURFACE_FREQUENCY = Math.sqrt(SURFACE_SPRING.stiffness / SURFACE_SPRING.mass) / (2 * Math.PI)
export const SURFACE_DAMPING = SURFACE_SPRING.damping / (2 * Math.sqrt(SURFACE_SPRING.stiffness * SURFACE_SPRING.mass))
/** Selection pill glides smoothly across segments while keeping momentum on reversal. */
export const SELECTION_SPRING = { frequency: 3.4, damping: .9 } as const
/** Monotonic switch/icon travel retains a fluid iOS settling tail with continuous reversal. */
export const TOGGLE_SPRING = { frequency: 2.4, damping: .92 } as const
export const GALLERY_SPRING = { frequency: 2.5, damping: .88 } as const
