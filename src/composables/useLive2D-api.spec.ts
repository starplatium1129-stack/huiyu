import { describe, expect, it } from 'vitest'
import { useLive2D } from '@/composables/useLive2D'

/**
 * useLive2D 组合根本体契约（2026-08-23 拆分收薄后补测）：
 * 公开 API 逐字冻结（消费方零改动承诺的回归金丝雀）+ 不依赖后端/会话的纯逻辑路径。
 * 子模块纯函数规格见 useLive2D.spec.ts（catalog/interactions/parameterFrame）。
 */
describe('useLive2D 组合根 · API 冻结契约', () => {
  it('preserves the public API and includes the additive imported-expression control', () => {
    const api = useLive2D()
    expect(Object.keys(api).sort()).toEqual([
      'adapterReport', 'attachEmotionRuntime', 'backendFallback', 'backendKind', 'character', 'destroy',
      'disable', 'enable', 'enabled', 'init', 'interactionHint', 'layout',
      'loadedCharacter', 'mouthValue', 'outfit', 'quality', 'ready', 'recover', 'releasePointerFocus',
      'retry', 'setAudioLevel', 'setCharacter', 'setDesktopWindowBounds', 'setExpression', 'setGlobalPointer',
      'setMaxFps', 'setMouth', 'setOutfit', 'setQuality', 'setVolume', 'setPaused', 'setSpeaking',
      'syncNativeEmotion',
    ].sort())
  })

  it('setMouth 钳制到 [0,1]，非数/越界回退安全值', () => {
    const api = useLive2D()
    api.setMouth(1.5)
    expect(api.mouthValue.value).toBe(1)
    api.setMouth(-1)
    expect(api.mouthValue.value).toBe(0)
    api.setMouth(0.42)
    expect(api.mouthValue.value).toBeCloseTo(0.42)
  })

  it('组合根构造不抛、不自动 init（后端/会话保持惰性，浏览器环境安全构造）', () => {
    const api = useLive2D()
    expect(api.ready.value).toBe(false)
    expect(api.enabled.value).toBe(false)
    expect(api.character.value).toBe('nene')
  })
})
