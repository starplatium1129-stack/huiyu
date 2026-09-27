'use strict';

let assert: typeof import('assert') = require('assert');
let test: typeof import('node:test') = require('node:test');
let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
const { sourceImports }: typeof import('../lib/source-imports') = require('../lib/source-imports');
const { inpaintCanvasSize, INPAINT_MAX_EDGE, INPAINT_MAX_AREA }: typeof import('../../src/utils/inpaintCanvas.ts') = require('../../src/utils/inpaintCanvas.ts');

test('inpaint canvas helper protects from oversize stretching and 16-aligned', function () {
  for (const [width, height] of [[4000, 3000], [1200, 4000], [4096, 4096], [256, 256]]) {
    const result = inpaintCanvasSize(width, height);
    assert.ok(result);
    assert.ok(result.width >= 512 && result.height >= 512);
    assert.ok(Math.max(result.width, result.height) <= INPAINT_MAX_EDGE);
    assert.ok(result.width * result.height <= INPAINT_MAX_AREA);
    assert.equal(result.width % 16, 0);
    assert.equal(result.height % 16, 0);
  }
  assert.deepEqual(inpaintCanvasSize(800, 1200), { width: 800, height: 1200 });
  for (const [width, height] of [[0, 512], [512, -1], [NaN, 512], [512, Infinity]]) {
    assert.equal(inpaintCanvasSize(width, height), null);
  }
});

test('AnimaInpaintModal delegates sizing to the shared canvas helper', function () {
  // 2026-08-22 画幅探测随图片源簇下沉 useInpaintImageSource，哨兵随之迁移。
  const root = path.resolve(__dirname, '../..');
  const owner = path.join(root, 'src/components/inpaint/useInpaintImageSource.ts');
  const source = fs.readFileSync(owner, 'utf8');
  assert.ok(sourceImports(source).some(edge => {
    if (edge.typeOnly) return false;
    const target = edge.specifier.startsWith('@/')
      ? path.join(root, 'src', edge.specifier.slice(2))
      : path.resolve(path.dirname(owner), edge.specifier);
    return target.replace(/\.[tj]s$/, '') === path.join(root, 'src/utils/inpaintCanvas');
  }), 'image source composable should import the shared helper');
  let modal = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'AnimaInpaintModal.vue'), 'utf8');
  assert.ok(!modal.includes('const INPAINT_MAX_EDGE'), 'duplicated constants must not remain in the modal');
  assert.ok(!source.includes('const INPAINT_MAX_EDGE'), 'duplicated constants must not remain in the composable');
});

test('hires on painted inpaint composites before upscaling', function () {
  // 2026-08-27 路由八模块化拆分：工作流编排迁入 routes/anima/workflows.js，
  // 契约哨兵需同时覆盖编排层入口与工作流构建体。
  let routing = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'anima.js'), 'utf8')
    + fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'anima', 'workflows.js'), 'utf8');
  // maskImage 分支已迁移到 30 号合成节点；hires 应在 30 之后再放大
  assert.ok(routing.includes("'30'") && routing.includes('ImageCompositeMasked'));
  assert.ok(routing.includes('input.maskImage') && routing.includes('if (isHires)'));
  // 关键：hires 的 mask 分支必须对合成结果做 VAEEncode/LatentUpscaleBy，而不是复用旧 firstPass 潜空间
  let maskSection = routing.slice(routing.indexOf("if (input.maskImage) {"), routing.indexOf("if (isHires)", routing.indexOf("if (input.maskImage) {")) + 800);
  assert.ok(maskSection.length > 0);
  let hiresSection = routing.slice(routing.indexOf('if (isHires)', routing.indexOf("'30'")), routing.indexOf('return noLoraWf', routing.indexOf("'30'")) + 500);
  assert.ok(hiresSection.includes("input.maskImage"), 'hires must special-case painted masks');
  assert.ok(hiresSection.includes("'31'") && hiresSection.includes("'32'") || hiresSection.includes('ImageScale'), 'hires must upscale the composited image');
});
