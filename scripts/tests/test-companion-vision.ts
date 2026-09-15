'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const {
  getCharacterInspectionPrompt,
}: typeof import('../../src/utils/companionVision.ts') = require('../../src/utils/companionVision.ts');

console.log('--- 测试 companionVision 看屏与视觉锐评工具 ---');

const natsumePrompt = getCharacterInspectionPrompt('natsume');
assert.match(natsumePrompt, /夏目/, '夏目 prompt 应包含夏目');
assert.match(natsumePrompt, /毒舌|傲娇/, '夏目 prompt 应要求毒舌/傲娇锐评');

const nenePrompt = getCharacterInspectionPrompt('nene');
assert.match(nenePrompt, /宁宁/, '宁宁 prompt 应包含宁宁');
assert.match(nenePrompt, /学姐/, '宁宁 prompt 应保留温柔学姐称呼');

console.log('✓ 1. 角色专属看屏锐评 Prompt 生成正确');
console.log('\nAll tests passed successfully!');

