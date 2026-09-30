'use strict';

let assert: typeof import('assert') = require('assert');
let test: typeof import('node:test') = require('node:test');
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
