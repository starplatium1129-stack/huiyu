const GRID_WIDTH = 48
const GRID_HEIGHT = 27
const TILE_WIDTH = 8
const TILE_HEIGHT = 9

export interface ScreenWatchFrame {
  width: number
  height: number
  luma: Uint8Array
}

/** Compare small regions as well as the whole frame, so captions can count. */
export function screenWatchChanged(before: ScreenWatchFrame, after: ScreenWatchFrame): boolean {
  if (before.width !== after.width || before.height !== after.height) return true
  let total = 0
  let strongest = 0
  for (let y = 0; y < GRID_HEIGHT; y += TILE_HEIGHT) {
    for (let x = 0; x < GRID_WIDTH; x += TILE_WIDTH) {
      let changed = 0
      for (let row = y; row < y + TILE_HEIGHT; row++) {
        for (let col = x; col < x + TILE_WIDTH; col++) {
          const pixel = row * GRID_WIDTH + col
          if (Math.abs(before.luma[pixel]! - after.luma[pixel]!) >= 22) changed++
        }
      }
      total += changed
      strongest = Math.max(strongest, changed)
    }
  }
  return total >= 110 || strongest >= 24
}

export function createScreenWatchCapture(stream: MediaStream, audioContext: AudioContext | null) {
  const video = document.createElement('video')
  const thumbnail = document.createElement('canvas')
  thumbnail.width = GRID_WIDTH
  thumbnail.height = GRID_HEIGHT
  const smallContext = thumbnail.getContext('2d', { willReadFrequently: true })
  if (!smallContext) throw new Error('当前窗口无法读取共享画面。')
  const image = document.createElement('canvas')
  const track = stream.getVideoTracks()[0]
  if (!track || track.readyState !== 'live') throw new Error('没有取得可用的共享画面。')
  let audioSource: MediaStreamAudioSourceNode | undefined
  let analyser: AnalyserNode | undefined
  let samples: Float32Array<ArrayBuffer> | undefined
  const audioTrack = stream.getAudioTracks()[0]
  if (audioContext && audioTrack) {
    try {
      audioSource = audioContext.createMediaStreamSource(new MediaStream([audioTrack]))
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      samples = new Float32Array(analyser.fftSize)
      audioSource.connect(analyser)
    } catch { analyser = undefined }
  }
  video.muted = true
  video.playsInline = true
  video.srcObject = stream

  function sample(): ScreenWatchFrame | null {
    if (track!.muted || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return null
    smallContext!.drawImage(video, 0, 0, GRID_WIDTH, GRID_HEIGHT)
    const rgba = smallContext!.getImageData(0, 0, GRID_WIDTH, GRID_HEIGHT).data
    const luma = new Uint8Array(GRID_WIDTH * GRID_HEIGHT)
    let hasPicture = false
    for (let i = 0; i < luma.length; i++) {
      const offset = i * 4
      const brightness = (rgba[offset]! * 54 + rgba[offset + 1]! * 183 + rgba[offset + 2]! * 19) >> 8
      luma[i] = brightness
      if (brightness > 8) hasPicture = true
    }
    return hasPicture ? { width: video.videoWidth, height: video.videoHeight, luma } : null
  }

  function jpeg() {
    const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight))
    image.width = Math.max(1, Math.round(video.videoWidth * scale))
    image.height = Math.max(1, Math.round(video.videoHeight * scale))
    const context = image.getContext('2d')
    if (!context) throw new Error('共享画面暂时无法转换。')
    context.drawImage(video, 0, 0, image.width, image.height)
    try { return image.toDataURL('image/jpeg', 0.78) }
    finally { image.width = 0 }
  }

  function hasAudio() {
    return Boolean(analyser && audioContext?.state === 'running' && audioTrack?.readyState === 'live' && !audioTrack.muted)
  }
  function audioActive() {
    if (!hasAudio() || !analyser || !samples) return false
    analyser.getFloatTimeDomainData(samples)
    let energy = 0
    for (const value of samples) energy += value * value
    return energy / samples.length > 0.00009
  }
  function pause(paused: boolean) {
    for (const mediaTrack of stream.getTracks()) mediaTrack.enabled = !paused
    if (paused) {
      video.pause()
      image.width = 0
    } else {
      return video.play()
    }
  }
  function close() {
    for (const mediaTrack of stream.getTracks()) mediaTrack.stop()
    video.pause()
    video.srcObject = null
    audioSource?.disconnect()
    analyser?.disconnect()
    thumbnail.width = 0
    image.width = 0
  }
  return { track, sample, jpeg, hasAudio, audioActive, pause, close, play: () => video.play() }
}
