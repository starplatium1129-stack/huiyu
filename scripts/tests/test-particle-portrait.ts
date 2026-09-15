'use strict';

// particlePortrait 背景剔除单元测试（2026-08-16）：
// samplePortraitPoints 应把整图点云的外圈主色当背景剔除（对齐参考实现的
// 「透明底剪影」），抠图素材（外圈透明）与多色杂底则跳过剔除。

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

test('整图点云：外圈主色被剔除，内部剪影保留', () => {
  // 外圈全部 'a'(=10)，内部 'b'(=11)
  const cloud = ringCloud('a', 'b')
  const sample = samplePortraitPoints(cloud, 100, 100, 100)
  assert.ok(sample.points.length > 0, '剪影内部点应保留')
  assert.ok(sample.points.every((point) => point.paint === 11),
    '背景色(10)格子必须被剔除，只留内部(11)')
  assert.ok(sample.points.length < 100 * 0.9, '剔除后点数应明显少于整图')
  // 2026-08-16 内容盒放大（0.96 → 1.02）：人物占屏约 94%，消除留白过多
  assert.ok(sample.boxW > 0.96 && sample.boxW <= 1.02, '内容盒放大到 1.02 以撑满场域')
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
