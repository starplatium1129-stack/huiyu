'use strict';

// Particle portraits preserve every encoded color; only explicit transparency removes cells.

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('assert') = require('assert');
const { samplePortraitPoints, shouldUnderlay }: typeof import('../../src/utils/particlePortrait.ts') = require('../../src/utils/particlePortrait.ts');

const PALETTE = Array.from({ length: 20 }, (_, index) => `#${index.toString(16).padStart(2, '0')}0000`)

function cloudFromCells(cells: string, w: number, h: number) {
  return {
    id: 'test',
    aspect: w / h,
    palette: PALETTE,
    grid: { w, h, cells },
  }
}

/** 12×10 网格：外圈两格填 value，内部填 interior。 */
function ringCloud(borderValue: string, interiorValue: string) {
  const w = 12
  const h = 10
  let cells = ''
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const onBorder = x < 2 || y < 2 || x >= w - 2 || y >= h - 2
      cells += onBorder ? borderValue : interiorValue
    }
  }
  return cloudFromCells(cells, w, h)
}

test('整图点云：边缘主色及内部同色细节全部保留', () => {
  const cloud = ringCloud('a', 'b')
  const sample = samplePortraitPoints(cloud, 120, 120, 100)
  assert.ok(sample.points.some(point => point.paint === 10), '边缘颜色不能被当作透明背景')
  assert.ok(sample.points.some(point => point.paint === 11), '内部颜色必须保留')
  const solid = samplePortraitPoints(ringCloud('a', 'a'), 120, 120, 100)
  assert.equal(sample.points.length, solid.points.length, '换色不能改变覆盖率或粒子数量')
  assert.ok(solid.points.length > 100, '同色主体不能整张消失')
  assert.ok(sample.boxW > 0.96 && sample.boxW <= 1.02)
})

test('抠图素材（外圈透明）：跳过剔除，内部全部保留', () => {
  const cloud = ringCloud('.', 'b')
  const sample = samplePortraitPoints(cloud, 100, 100, 100)
  assert.ok(sample.points.length > 0)
  assert.ok(sample.points.every((point) => point.paint === 11),
    '外圈透明时不得误删内部点')
})

test('多色杂底（外圈主色 >3 个）：保守跳过，不误伤', () => {
  const w = 12
  const h = 10
  const borderColors = ['a', 'c', 'd', 'e'] // 10,12,13,14 各占 25%
  let cells = ''
  let borderIndex = 0
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const onBorder = x < 2 || y < 2 || x >= w - 2 || y >= h - 2
      if (onBorder) {
        cells += borderColors[borderIndex % borderColors.length]
        borderIndex += 1
      } else {
        cells += 'b'
      }
    }
  }
  const sample = samplePortraitPoints(cloudFromCells(cells, w, h), 100, 100, 100)
  assert.ok(sample.points.length > 0)
  assert.ok(sample.points.some((point) => point.paint === 11),
    '背景色过多时不得剔除，内部点必须存在')
})

test('shouldUnderlay 深色衬底只给极亮色（>0.72，2026-08-16 亮色主题反馈）', () => {
  assert.equal(shouldUnderlay('#f8f8f8'), true, '近白需要衬底')
  assert.equal(shouldUnderlay('#e8e8e8'), true, '亮度 0.91 垫')
  assert.equal(shouldUnderlay('#c8c8c8'), true, '亮度 0.78 垫')
  assert.equal(shouldUnderlay('#b6b6b6'), false, '亮度 0.71 不垫（0.62 阈值实测白发区连成灰雾）')
  assert.equal(shouldUnderlay('#999999'), false, '中亮不垫')
  assert.equal(shouldUnderlay('#666666'), false)
  assert.equal(shouldUnderlay('#404040'), false, '暗色不垫')
  assert.equal(shouldUnderlay('not-a-color'), false, '非法颜色不垫')
})
