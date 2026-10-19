/** Interaction tuning adapted from Caho1/open-claude-ui, MIT © 2026 Caho1.
 * Source: 638800b8a4cee4513c8763c3df0ecf8a77b32379/code-examples/ClaudeMotionPresets.ts
 * License: assets/licenses/open-claude-ui.txt. */
export const BUTTON_SPRING = { type: 'spring', stiffness: 600, damping: 30, mass: 1 } as const
/** Faster first arrival with a visible single rebound; input never waits for settling. */
export const SURFACE_SPRING = { stiffness: 720, damping: 32, mass: 1 } as const
export const SURFACE_FREQUENCY = Math.sqrt(SURFACE_SPRING.stiffness / SURFACE_SPRING.mass) / (2 * Math.PI)
export const SURFACE_DAMPING = SURFACE_SPRING.damping / (2 * Math.sqrt(SURFACE_SPRING.stiffness * SURFACE_SPRING.mass))
/** Selection keeps momentum on reversal; covers settle with a slower, shallow rebound. */
export const SELECTION_SPRING = { frequency: 5.5, damping: .86 } as const
/** Monotonic switch/icon travel retains the gentle control's visible settling
 * tail, with a continuous clock instead of CSS reverse-duration shortening. */
export const TOGGLE_SPRING = { frequency: 3, damping: 1 } as const
export const GALLERY_SPRING = { frequency: 3.6, damping: .82 } as const
