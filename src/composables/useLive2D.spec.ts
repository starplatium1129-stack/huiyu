import { describe, expect, it } from 'vitest'
import { readLive2DCatalog } from './live2d/catalog'
import {
  resolveHitAreaInteraction,
  resolveStageInteraction,
} from './live2d/interactions'
import {
  selectBlinkParams,
  selectMouthParams,
} from './live2d/parameterFrame'

/**
 * useLive2D 纯函数契约（拆分 Step 0 测试地基）：
 * 分区带映射 / 夏目外框 HitArea 排序兜底 / catalog 宽松解析 / MOUTH·BLINK 参数选择。
 * 依据 docs/live2d-composable-refactor-plan.md——后续每步拆分以这些规格为金丝雀。
 */

describe('resolveStageInteraction · 分区带映射', () => {
  it('夏目按头/手/胸/裙/腿/脚六段 y 分区，边界值落在下一段', () => {
    expect(resolveStageInteraction('natsume', 0.5, 0.13)?.group).toBe('TapHead')
    expect(resolveStageInteraction('natsume', 0.5, 0.14)?.group).toBe('TapHand')
    expect(resolveStageInteraction('natsume', 0.5, 0.26)?.group).toBe('TapChest')
    expect(resolveStageInteraction('natsume', 0.5, 0.38)?.group).toBe('TapSkirt')
    expect(resolveStageInteraction('natsume', 0.5, 0.55)?.group).toBe('TapLeg')
    expect(resolveStageInteraction('natsume', 0.5, 0.72)?.group).toBe('TapFoot')
    expect(resolveStageInteraction('natsume', 0.5, 0.99)?.group).toBe('TapFoot')
  })

  it('宁宁呆毛/头/脸三段窄带 + 裙摆带，其余落 Body', () => {
    expect(resolveStageInteraction('nene', 0.5, 0.11)?.group).toBe('TapHair')
    expect(resolveStageInteraction('nene', 0.5, 0.12)?.group).toBe('TapHead')
    expect(resolveStageInteraction('nene', 0.5, 0.19)?.group).toBe('TapFace')
    expect(resolveStageInteraction('nene', 0.5, 0.42)?.group).toBe('TapSkirt')
    expect(resolveStageInteraction('nene', 0.5, 0.57)?.group).toBe('TapBody')
    expect(resolveStageInteraction('nene', 0.5, 0.95)?.group).toBe('TapBody')
  })

  it('宁宁胸前互动带收紧：x∈[0.40,0.50) 左、[0.50,0.60] 右，带外侧身体点击不误触', () => {
    expect(resolveStageInteraction('nene', 0.40, 0.35)?.group).toBe('TapLeftChest')
    expect(resolveStageInteraction('nene', 0.4999, 0.35)?.group).toBe('TapLeftChest')
    expect(resolveStageInteraction('nene', 0.50, 0.35)?.group).toBe('TapRightChest')
    expect(resolveStageInteraction('nene', 0.60, 0.35)?.group).toBe('TapRightChest')
    // 肩部/腰部等带内非胸口位置：不满足胸带也不满足裙带（y<0.42），落 Body
    expect(resolveStageInteraction('nene', 0.39, 0.35)?.group).toBe('TapBody')
    expect(resolveStageInteraction('nene', 0.61, 0.35)?.group).toBe('TapBody')
    // 胸带 y 范围外的同一 x 不触发胸互动
    expect(resolveStageInteraction('nene', 0.45, 0.28)?.group).toBe('TapFace')
  })

  it('未知角色不借用宁宁的互动分区', () => {
    expect(resolveStageInteraction('unknown', 0.5, 0.05)).toBeNull()
    expect(resolveStageInteraction('unknown', 0.5, 0.9)).toBeNull()
  })
})

describe('resolveHitAreaInteraction · 夏目外框排序兜底', () => {
  it('外框排在具体分区之后：具体分区优先命中', () => {
    expect(resolveHitAreaInteraction('natsume', ['外框', '摸头'])?.group).toBe('TapHead')
    expect(resolveHitAreaInteraction('natsume', ['外框', '摸手'])?.group).toBe('TapHand')
    expect(resolveHitAreaInteraction('natsume', ['摸腿', '外框'])?.group).toBe('TapLeg')
  })

  it('仅外框命中时兜底为"抬眼"互动', () => {
    expect(resolveHitAreaInteraction('natsume', ['外框'])?.group).toBe('TapFrame')
  })

  it('未映射区域与空数组返回 null', () => {
    expect(resolveHitAreaInteraction('natsume', ['未知区域'])).toBeNull()
    expect(resolveHitAreaInteraction('natsume', [])).toBeNull()
    expect(resolveHitAreaInteraction('nene', ['Hair'])?.group).toBe('TapHair')
    expect(resolveHitAreaInteraction('nene', ['不存在'])).toBeNull()
  })
})

describe('readLive2DCatalog · 宽松解析', () => {
  it('完整字段原样读取，missing 过滤非字符串', () => {
    const catalog = readLive2DCatalog({
      models: {
        nene: {
          available: true,
          modelUrl: '/data/live2d/nene/nene.model3.json',
          source: 'local',
          missing: ['textures/00.png', 42, null],
        },
      },
    })
    expect(catalog.models.nene).toEqual({
      available: true,
      modelUrl: '/data/live2d/nene/nene.model3.json',
      source: 'local',
      missing: ['textures/00.png'],
      canvas: undefined,
    })
  })

  it('canvas 数值宽松换算：数字字符串可解析，非法值回退 420×610', () => {
    const catalog = readLive2DCatalog({
      models: {
        a: { available: true, canvas: { width: '600', height: 0 } },
        b: { available: true, canvas: { width: NaN, height: 'abc' } },
      },
    })
    expect(catalog.models.a.canvas).toEqual({ width: 600, height: 610 })
    expect(catalog.models.b.canvas).toEqual({ width: 420, height: 610 })
  })

  it('非对象条目跳过，缺省字段给安全默认值', () => {
    const catalog = readLive2DCatalog({
      models: {
        broken: 'not-an-object',
        natsume: { available: 1 },
      },
    })
    expect(catalog.models.broken).toBeUndefined()
    expect(catalog.models.natsume.available).toBe(true)
    expect(catalog.models.natsume.modelUrl).toBe('')
    expect(catalog.models.natsume.missing).toEqual([])
  })

  it('顶层缺 models 或非对象时抛格式错误', () => {
    expect(() => readLive2DCatalog(null)).toThrow('Live2D 状态响应格式无效')
    expect(() => readLive2DCatalog({})).toThrow('Live2D 状态响应格式无效')
    expect(() => readLive2DCatalog({ models: 'bad' })).toThrow('Live2D 状态响应格式无效')
    expect(readLive2DCatalog({ models: {} })).toEqual({ models: {} })
  })
})

describe('MOUTH / BLINK 参数选择', () => {
  it('宁宁口型走 ParamMouthOpenY，夏目走 ParamMouthForm3 反相缩放', () => {
    expect(selectMouthParams('nene')).toEqual({ id: 'ParamMouthOpenY', scale: 1 })
    expect(selectMouthParams('natsume')).toEqual({ id: 'ParamMouthForm3', scale: -0.5 })
  })

  it('未知角色不借用宁宁口型参数', () => {
    expect(selectMouthParams('someone-else')).toBeUndefined()
  })

  it('眨眼参数双眼成对：夏目第二只为 ParamEyeLOpen2（作者曲线怪癖）', () => {
    expect(selectBlinkParams('nene')).toEqual(['ParamEyeLOpen', 'ParamEyeROpen'])
    expect(selectBlinkParams('natsume')).toEqual(['ParamEyeLOpen', 'ParamEyeLOpen2'])
    expect(selectBlinkParams('unknown')).toBeUndefined()
  })
})
