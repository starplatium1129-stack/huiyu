// Only WAV blobs are bounded; lightweight /api/tts URLs remain replayable.
// The backend may synthesize again once its own bounded cache evicts a clip.
const MAX_MESSAGES = 8
const MAX_BYTES = 16 * 1024 * 1024
interface Clip { url: string }
interface Entry { mid: string; url: string; fallback: string; bytes: number; pinned: boolean; removed: boolean }

export class VoiceReplayCache {
  private entries = new Map<Clip, Entry>()
  private bytes = 0

  remember(mid: string, clip: Clip, blob: Blob, fallback: string) {
    clip.url = fallback
    if (blob.size > MAX_BYTES) return
    const entry = { mid, url: URL.createObjectURL(blob), fallback, bytes: blob.size, pinned: false, removed: false }
    clip.url = entry.url
    this.entries.set(clip, entry); this.bytes += entry.bytes
    while (this.bytes > MAX_BYTES || new Set([...this.entries.values()].map(value => value.mid)).size > MAX_MESSAGES) {
      const oldest = [...this.entries].find(([, value]) => !value.pinned)
      if (!oldest) break
      this.remove(oldest[0])
    }
  }

  // Removing a message during replay must not revoke its currently playing URL.
  pin(clip: Clip): () => void {
    const entry = this.entries.get(clip)
    if (!entry) return () => {}
    entry.pinned = true
    return () => {
      entry.pinned = false
      if (entry.removed) this.remove(clip)
    }
  }

  remove(clip: Clip) {
    const entry = this.entries.get(clip)
    if (!entry) return
    clip.url = entry.fallback
    if (entry.pinned) { entry.removed = true; return }
    this.entries.delete(clip); this.bytes -= entry.bytes
    URL.revokeObjectURL(entry.url)
  }
}
