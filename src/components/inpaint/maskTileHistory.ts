const TILE_SIZE = 128
const MAX_UNDO_STEPS = 20
const MAX_UNDO_BYTES = 24 * 1024 * 1024

type TileSnapshot = { x: number; y: number; data: ImageData; possiblyPainted: boolean }
type MaskStroke = { tiles: Map<string, TileSnapshot>; bytes: number }

/** Mask-only history: save each touched tile once, before its first write in a stroke. */
export class MaskTileHistory {
  readonly strokes: MaskStroke[] = []
  private paintedTiles = new Map<string, { x: number; y: number }>()
  private bytes = 0
  private current: MaskStroke | null = null

  begin() {
    this.current = { tiles: new Map(), bytes: 0 }
  }

  end() { this.current = null }

  clear() {
    this.end()
    this.strokes.length = 0
    this.paintedTiles.clear()
    this.bytes = 0
  }

  private trim() {
    // Keep the current stroke atomic even if an unusually large canvas exceeds the budget.
    // Normal inpaint canvases are capped upstream and fit comfortably within 24 MiB.
    while (this.strokes.length > 1 && (this.strokes.length > MAX_UNDO_STEPS || this.bytes > MAX_UNDO_BYTES)) {
      this.bytes -= this.strokes.shift()!.bytes
    }
  }

  capture(context: CanvasRenderingContext2D, left: number, top: number, right: number, bottom: number) {
    if (!this.current) return
    const { width, height } = context.canvas
    const x0 = Math.max(0, Math.floor(left / TILE_SIZE) * TILE_SIZE)
    const y0 = Math.max(0, Math.floor(top / TILE_SIZE) * TILE_SIZE)
    for (let y = y0; y < Math.min(height, bottom); y += TILE_SIZE) {
      for (let x = x0; x < Math.min(width, right); x += TILE_SIZE) {
        const key = `${x},${y}`
        if (!this.current.tiles.has(key)) {
          const data = context.getImageData(x, y, Math.min(TILE_SIZE, width - x), Math.min(TILE_SIZE, height - y))
          if (!this.current.tiles.size) this.strokes.push(this.current)
          this.current.tiles.set(key, { x, y, data, possiblyPainted: this.paintedTiles.has(key) })
          this.current.bytes += data.data.byteLength
          this.bytes += data.data.byteLength
        }
        this.paintedTiles.set(key, { x, y })
      }
    }
    this.trim()
  }

  undo(context: CanvasRenderingContext2D) {
    this.end()
    const stroke = this.strokes.pop()
    if (!stroke) return
    for (const [key, tile] of stroke.tiles) {
      context.putImageData(tile.data, tile.x, tile.y)
      if (tile.possiblyPainted) this.paintedTiles.set(key, { x: tile.x, y: tile.y })
      else this.paintedTiles.delete(key)
    }
    this.bytes -= stroke.bytes
  }

  hasPaint(context: CanvasRenderingContext2D): boolean {
    const { width, height } = context.canvas
    for (const [key, { x, y }] of this.paintedTiles) {
      const { data } = context.getImageData(x, y, Math.min(TILE_SIZE, width - x), Math.min(TILE_SIZE, height - y))
      // Alpha is authoritative; avoid callback overhead and scanning RGB channels.
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] !== 0) return true
      }
      this.paintedTiles.delete(key)
    }
    return false
  }
}
