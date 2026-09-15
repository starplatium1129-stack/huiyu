'use strict';

/**
 * src/utils/interrogateMerge 契约测试（2026-08-29 反推优化）。
 *
 * 覆盖反推词条「不重复叠加」与「人物身份冲突消解」两条契约：
 *   - 三重去重：manualTags / 身份行（charPrompt、identityTokens+outfit）/
 *     场景行（scene.prompt、blueprint.promptTokens）已有的词条一律跳过；
 *   - 身份域冲突：反推词条命中发色/瞳色/发型/发长/主体数量域，且当前身份行
 *     在该域已有取值但不含此词条 → 跳过并给出域与原因；
 *   - 角色名冲突说明：characterTags 与当前角色触发词不同 → 返回提示文案。
 */

const assert: typeof import('assert/strict') = require('assert/strict');
const { test }: typeof import('node:test') = require('node:test');
const {
  mergeInterrogatedTags,
  characterConflictNote,
  collectInterrogateContext,
  identityDomainOf,
}: typeof import('../../src/utils/interrogateMerge.ts') = require('../../src/utils/interrogateMerge.ts');

const NENE_IDENTITY = [
  '1girl', 'solo', 'ayachi_nene', 'white_hair', 'very_long_hair',
  'low_twintails', 'purple_eyes', 'ahoge', 'pink_hair_ribbons',
];

test('三重去重：manualTags/身份行/场景行已有的词条全部跳过', () => {
  const result = mergeInterrogatedTags({
    tags: ['blush', 'white_hair', 'classroom', 'looking_at_viewer', 'sitting'],
    manualTags: new Set(['blush']),
    identityTokens: NENE_IDENTITY,
    sceneTokens: ['classroom', 'school_uniform'],
  });
  assert.deepEqual(result.accepted, ['looking_at_viewer', 'sitting']);
  assert.deepEqual(result.duplicates.sort(), ['blush', 'classroom', 'white_hair']);
  assert.equal(result.conflicts.length, 0);
});

test('身份域冲突：发色/瞳色/发型/发长与当前角色同域不同值即跳过', () => {
  const result = mergeInterrogatedTags({
    tags: ['black_hair', 'blue_eyes', 'twintails', 'short_hair', 'wet_hair', 'bare_shoulders'],
    manualTags: new Set(),
    identityTokens: NENE_IDENTITY,
    sceneTokens: [],
  });
  const conflictTags = result.conflicts.map(item => item.tag);
  // black_hair（发色）/ blue_eyes（瞳色）/ twintails（发型）/ short_hair（发长）→ 冲突
  for (const tag of ['black_hair', 'blue_eyes', 'twintails', 'short_hair']) {
    assert.ok(conflictTags.includes(tag), `${tag} 应被判定身份冲突`);
  }
  // wet_hair（状态词，不属颜色/长度域）与 bare_shoulders（非身份域）→ 接受
  assert.ok(result.accepted.includes('bare_shoulders'));
  assert.ok(result.accepted.includes('wet_hair'), '状态词 wet_hair 不应误判为发色冲突');
  for (const conflict of result.conflicts) {
    assert.ok(conflict.domain && conflict.reason.includes('当前角色'), '冲突必须带域与原因');
  }
});

test('身份域为空时接受：当前角色无该域取值则反推词可叠加', () => {
  // 夏目无 hair_ribbon（no_hair_ribbon），但 identityTokens 也无 hat 域词
  const natsumeIdentity = ['1girl', 'solo', 'shiki_natsume', 'very_long_black_hair', 'golden_yellow_eyes', 'mole_under_eye'];
  const result = mergeInterrogatedTags({
    tags: ['hat', 'black_hair'],
    manualTags: new Set(),
    identityTokens: natsumeIdentity,
    sceneTokens: [],
  });
  assert.ok(result.accepted.includes('hat'), '无帽域取值时应接受 hat');
  assert.ok(!result.accepted.includes('black_hair'), '发色域已有 very_long_black_hair 占位（同域）');
});

test('主体数量域：识别出 2girls 与当前 solo/1girl 冲突', () => {
  const result = mergeInterrogatedTags({
    tags: ['2girls', 'multiple_girls'],
    manualTags: new Set(),
    identityTokens: NENE_IDENTITY,
    sceneTokens: [],
  });
  assert.deepEqual(result.accepted, []);
  assert.equal(result.conflicts.length, 2);
  assert.ok(result.conflicts.every(item => item.domain === '主体数量'));
});

test('identityDomainOf：域判定抽查', () => {
  assert.equal(identityDomainOf('purple_hair')?.name, 'hairColor');
  assert.equal(identityDomainOf('golden_eyes')?.name, 'eyeColor');
  assert.equal(identityDomainOf('side_bun')?.name, 'hairStyle');
  assert.equal(identityDomainOf('very_long_hair')?.name, 'hairLength');
  assert.equal(identityDomainOf('1girl')?.name, 'subjectCount');
  assert.equal(identityDomainOf('school_uniform'), null, '服装不属身份域');
  assert.equal(identityDomainOf('looking_at_viewer'), null);
});

test('characterConflictNote：识别出其他角色返回提示，识别出当前角色返回 null', () => {
  const note = characterConflictNote(['hatsune_miku', 'kagamine_rin'], NENE_IDENTITY);
  assert.ok(note && note.includes('hatsune_miku') && note.includes('已按当前角色作画'));
  assert.equal(characterConflictNote([], NENE_IDENTITY), null);
  assert.equal(characterConflictNote(undefined, NENE_IDENTITY), null);
});

test('collectInterrogateContext：studio 用 charPrompt+场景，popular 用角色词条+蓝图', () => {
  const studio = collectInterrogateContext({
    kind: 'studio',
    charPrompt: '1girl, solo, ayachi_nene, white_hair, purple_eyes',
    scenePrompt: '1girl, classroom, school_uniform, <lora:ayachi_nene_v21_anima:0.8>',
    sceneTags: ['hair_ribbon'],
  });
  assert.ok(studio.identityTokens.includes('ayachi_nene'));
  assert.ok(studio.sceneTokens.includes('classroom'));
  assert.ok(!studio.sceneTokens.includes('hair_ribbon'), '搜索标签不参与编译上下文');

  const popular = collectInterrogateContext({
    kind: 'popular',
    character: {
      identityTokens: ['frieren', '1girl', 'solo', 'purple_eyes'],
      exactTokens: ['frieren'],
      outfitTokens: ['robe', 'white_robe'],
    },
    blueprintTokens: ['library', 'sitting'],
  });
  assert.deepEqual(popular.identityTokens, ['frieren', '1girl', 'solo', 'purple_eyes', 'frieren', 'robe', 'white_robe']);
  assert.deepEqual(popular.sceneTokens, ['library', 'sitting']);
});
