/**
 * Live2D 凝视轨迹纯函数。
 *
 * DOM 与全局鼠标只更新 target；渲染层逐帧调用 stepGaze()，从当前可见值
 * 平滑追向目标。这样浏览器 focus 与原生 bridge 共用同一条连续轨迹。
 */

export interface Live2DGazePoint {
  x: number
  y: number
}

export interface Live2DGazeRect {
  left: number
  top: number
  width: number
  height: number
}

function clampGaze(value: number, limit = 1): number {
  const safeLimit = Math.max(0, Math.min(1, Number(limit) || 0))
  return Math.max(-safeLimit, Math.min(safeLimit, Number(value) || 0))
}

export function gazeFromClientPoint(
  clientX: number,
  clientY: number,
  rect: Live2DGazeRect,
  limit = 1,
): Live2DGazePoint {
  if (!rect.width || !rect.height) return { x: 0, y: 0 }
  return {
    x: clampGaze(((clientX - rect.left) / rect.width - 0.5) * 2, limit),
    y: clampGaze(((clientY - rect.top) / rect.height - 0.5) * -2, limit),
  }
}

export function stepGaze(
  current: Live2DGazePoint,
  target: Live2DGazePoint,
  deltaSeconds: number,
  response = 10,
): Live2DGazePoint {
  const dt = Math.max(0, Math.min(0.1, Number(deltaSeconds) || 0))
  const rate = Math.max(0, Number(response) || 0)
  const blend = 1 - Math.exp(-rate * dt)
  return {
    x: current.x + (target.x - current.x) * blend,
    y: current.y + (target.y - current.y) * blend,
  }
}

export function gazeSettled(current: Live2DGazePoint, target: Live2DGazePoint, epsilon = 0.002): boolean {
  return Math.abs(current.x - target.x) <= epsilon && Math.abs(current.y - target.y) <= epsilon
}
