'use strict';

var assert: typeof import('assert') = require('assert');
var test: typeof import('node:test') = require('node:test');
var fs: typeof import('fs') = require('fs');
var path: typeof import('path') = require('path');

function stripComments(input: string) {
  return input.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('inpaint canvas helper protects from oversize stretching and 16-aligned', function () {
  var source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'utils', 'inpaintCanvas.ts'), 'utf8');
  var clean = stripComments(source);
  assert.ok(clean.includes("inpaintCanvasSize"), 'helper must export inpaintCanvasSize');
  assert.ok(clean.includes('INPAINT_MAX_EDGE') && clean.includes('INPAINT_MAX_AREA'));
  assert.ok(clean.includes('% 16') || clean.includes('/ 16'), 'output must be 16-aligned');
  assert.ok(clean.includes('512'), 'must enforce minimum dimension');
});

test('AnimaInpaintModal delegates sizing to the shared canvas helper', function () {
  // 2026-08-22 画幅探测随图片源簇下沉 useInpaintImageSource，哨兵随之迁移。
  var source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'inpaint', 'useInpaintImageSource.ts'), 'utf8');
  assert.ok(source.includes("from '@/utils/inpaintCanvas'") || source.includes('from \"@/utils/inpaintCanvas\"'), 'image source composable should import the shared helper');
  var modal = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'AnimaInpaintModal.vue'), 'utf8');
  assert.ok(!modal.includes('const INPAINT_MAX_EDGE'), 'duplicated constants must not remain in the modal');
  assert.ok(!source.includes('const INPAINT_MAX_EDGE'), 'duplicated constants must not remain in the composable');
});

test('hires on painted inpaint composites before upscaling', function () {
  // 2026-08-27 路由八模块化拆分：工作流编排迁入 routes/anima/workflows.js，
  // 契约哨兵需同时覆盖编排层入口与工作流构建体。
  var routing = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'anima.js'), 'utf8')
    + fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'anima', 'workflows.js'), 'utf8');
  // maskImage 分支已迁移到 30 号合成节点；hires 应在 30 之后再放大
  assert.ok(routing.includes("'30'") && routing.includes('ImageCompositeMasked'));
  assert.ok(routing.includes('input.maskImage') && routing.includes('if (isHires)'));
  // 关键：hires 的 mask 分支必须对合成结果做 VAEEncode/LatentUpscaleBy，而不是复用旧 firstPass 潜空间
  var maskSection = routing.slice(routing.indexOf("if (input.maskImage) {"), routing.indexOf("if (isHires)", routing.indexOf("if (input.maskImage) {")) + 800);
  assert.ok(maskSection.length > 0);
  var hiresSection = routing.slice(routing.indexOf('if (isHires)', routing.indexOf("'30'")), routing.indexOf('return noLoraWf', routing.indexOf("'30'")) + 500);
  assert.ok(hiresSection.includes("input.maskImage"), 'hires must special-case painted masks');
  assert.ok(hiresSection.includes("'31'") && hiresSection.includes("'32'") || hiresSection.includes('ImageScale'), 'hires must upscale the composited image');
});
