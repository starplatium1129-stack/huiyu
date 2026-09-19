import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

/**
 * server/interrogate-engine 契约测试（2026-08-29 新增：真实反推模型接入）。
 * 环境无关设计：
 *   - 无 WD14 模型 → 验证降级路径（probe available=false、findModel=null、interrogateTag ok=false）；
 *   - 有 WD14 模型（本机 ComfyUI-WD14-Tagger 权重）→ 额外验证真实推理：
 *     标签表结构（9083 行 / general 起点 4 / character 起点 6951）、
 *     sharp 生成测试图 → 反推输出结构（tags/scores/rating/characterTags 契约）、
 *     rating 四键齐全、scores 与 tags 一一对应。
 */

let assert: typeof import('assert/strict') = require('assert/strict');
let path: typeof import('path') = require('path');
let engine: typeof import('../../server/interrogate-engine') = require('../../server/interrogate-engine');

let ROOT = path.resolve(__dirname, '..', '..');
let EMPTY_DIR = path.join(ROOT, 'runtime', 'models', 'interrogate-empty');
let EMPTY_CONFIG = { AI_WORKSPACE_ROOT: EMPTY_DIR, ROOT_DIR: EMPTY_DIR };
let REAL_CONFIG = { AI_WORKSPACE_ROOT: path.join(ROOT, '..', 'AI'), ROOT_DIR: ROOT };

async function generateTestImage() {
  // 用 sharp 生成一张 512x768 渐变图（有颜色差异，WD14 可反推出 general 标签）
  let sharp: typeof import('sharp').default = require('sharp');
  let width = 512, height = 768;
  let data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let o = (y * width + x) * 3;
      data[o] = Math.floor(255 * x / width);          // R 渐变
      data[o + 1] = Math.floor(255 * y / height);     // G 渐变
      data[o + 2] = 180;                              // B 固定
    }
  }
  return sharp(data, { raw: { width: width, height: height, channels: 3 } }).png().toBuffer();
}

async function run() {
  let failures = 0;
  async function check(name: string, fn: any) {
    try { await fn(); console.log('  ✔ ' + name); }
    catch (e) { failures++; console.error('  ✘ ' + name + ' — ' + runtimeErrorMessage(e)); }
  }

  // 1) 降级路径（恒成立，CI 无模型也过）
  engine._resetModelCache();
  let probeEmpty = engine.probe(EMPTY_CONFIG);
  check('probe(无模型) available=false', function () {
    assert.equal(probeEmpty.available, false);
    assert.equal(typeof probeEmpty.reason, 'string');
  });
  check('findModel(无模型) = null', function () {
    assert.equal(engine.findModel(EMPTY_CONFIG), null);
  });
  check('interrogateTag(无模型) ok=false 且降级原因明确', async function () {
    let r = await engine.interrogateTag(Buffer.from([1, 2, 3]), { config: EMPTY_CONFIG });
    assert.equal(r.ok, false);
    assert.ok(r.reason && r.reason.length > 0);
  });

  // 2) 真实模型路径（本机有权重时执行；无则跳过打印）
  engine._resetModelCache();
  let model = engine.findModel(REAL_CONFIG);
  if (!model) {
    console.log('  ↪ 本机无 WD14 模型，跳过真实推理断言（仅降级路径验证）');
  } else {
    console.log('  模型: ' + model.modelName + ' (' + Math.round(model.bytes / 1024 / 1024) + 'MB) @ ' + model.dir);
    let tags = engine.loadTags(model.csvPath);

    check('标签表契约: 9083 行 / general@4 / character@6951', function () {
      assert.equal(tags.names.length, 9083);
      assert.equal(tags.generalIndex, 4);
      assert.equal(tags.characterIndex, 6951);
      assert.deepEqual(tags.names.slice(0, 4), ['general', 'sensitive', 'questionable', 'explicit']);
      assert.equal(tags.names[tags.generalIndex], '1girl');
      assert.equal(tags.names[tags.characterIndex], 'hatsune_miku');
    });

    let probeReal = engine.probe(REAL_CONFIG);
    check('probe(有模型) available=true 且模型元信息完整', function () {
      assert.equal(probeReal.available, true);
      assert.equal(probeReal.model, model!.modelName);
      assert.ok(probeReal.modelPath && probeReal.modelBytes > 0);
    });

    let image = await generateTestImage();
    let r: any = await engine.interrogateTag(image, { config: REAL_CONFIG, threshold: 0.35 });
    check('真实推理: ok=true / engine=wd14 / tags 非空', function () {
      assert.equal(r.ok, true);
      assert.equal(r.engine, 'wd14');
      assert.equal(r.model, model!.modelName);
      assert.ok(Array.isArray(r.tags) && r.tags.length > 0, 'tags 为空');
      assert.ok(r.tags.length <= 100, '默认 topN=100 上限');
    });
    check('真实推理: scores 与 tags 一一对应且为概率值', function () {
      r.tags.forEach(function (t: any) {
        assert.ok(Object.prototype.hasOwnProperty.call(r.scores, t), 'score 缺 ' + t);
        assert.ok(r.scores[t] > 0.35 && r.scores[t] <= 1.001, t + ' 概率越界: ' + r.scores[t]);
      });
    });
    check('真实推理: rating 四键齐全且为独立 sigmoid 概率', function () {
      ['general', 'sensitive', 'questionable', 'explicit'].forEach(function (k) {
        assert.equal(typeof r.rating[k], 'number', 'rating 缺 ' + k);
        assert.ok(r.rating[k] >= 0 && r.rating[k] <= 1, k + ' 概率越界: ' + r.rating[k]);
      });
      // WD14 的 rating 是独立 sigmoid（非互斥 softmax），主导评级应有明显置信度
      let maxRating = Math.max(r.rating.general, r.rating.sensitive, r.rating.questionable, r.rating.explicit);
      assert.ok(maxRating > 0.5, '无主导评级');
    });
    check('真实推理: characterTags 均落在 character 区间且阈值更高', function () {
      assert.ok(Array.isArray(r.characterTags));
      r.characterTags.forEach(function (t: any) {
        let idx = tags.names.indexOf(t);
        assert.ok(idx >= tags.characterIndex, t + ' 不在 character 区间');
        assert.ok(r.scores[t] > 0.85, t + ' 低于 character 阈值');
      });
    });
    check('真实推理: tags 与 characterTags 彻底分离（角色名不混入 tags）', function () {
      // 2026-08-29：tags 只含 general 区间词条；角色名单独走 characterTags，
      // 防止识别出的角色名随大流写入 manualTags 与当前作画角色冲突。
      let characterSet = new Set(r.characterTags);
      r.tags.forEach(function (t: any) {
        assert.ok(!characterSet.has(t), t + ' 不得同时出现在 tags 与 characterTags');
      });
    });
    check('真实推理: meta 携带引擎信息', function () {
      assert.equal(r.meta.threshold, 0.35);
      assert.equal(typeof r.meta.modelPath, 'string');
    });
  }

  if (failures) throw new Error(failures + ' 项断言失败');
  console.log('test-interrogate-engine: ok');
}

run().catch(function (error) {
  console.error(error);
  process.exit(1);
});
