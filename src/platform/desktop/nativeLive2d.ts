import type { Live2DNativeBridge } from '../../types/live2dNative.ts'
import { getDesktopRuntime } from './runtime.ts'
import { hostApi, invokeHost as invoke, onHostEvent as on, offHostEvent as off } from './hostApi.ts'

const native: Live2DNativeBridge = {
  isNativeLive2D: true, supportsTextureQuality: true, supportsFraming: true,
  setCharacter: (modelPath, options) => invoke('aics_live2d_set_character', { modelPath, character: options?.character, textureScale: options?.textureScale, adapter: options?.adapter }),
  setFrame: frame => invoke('aics_live2d_set_frame', { rect: frame.rect, visible: frame.visible, opacity: frame.opacity ?? null, framing: frame.framing ?? null }),
  setMaxFps: fps => invoke('aics_live2d_set_max_fps', { fps }),
  playMotion: (group, index, priority) => invoke('aics_live2d_play_motion', { group, index: index ?? null, priority: priority ?? null }),
  setExpression: name => invoke('aics_live2d_set_expression', { name }),
  setMouthLevel: level => invoke('aics_live2d_set_mouth_level', { level }),
  setEmotion: (name, intensity) => invoke('aics_live2d_set_emotion', { name, intensity }),
  setGaze: (x, y) => invoke('aics_live2d_set_gaze', { x, y }),
  hitTest: (x, y) => invoke('aics_live2d_hit_test', { x, y }), destroy: () => invoke('aics_live2d_destroy'),
  onMotionFailed: listener => on('aics:live2d:motion-failed', listener),
  onStopped: listener => on('aics:live2d:stopped', listener), off,
}
export function getNativeLive2dCapabilities(): Live2DNativeBridge | undefined {
  return hostApi() && getDesktopRuntime().bootstrap?.windowRole === 'companion' ? native : undefined
}
