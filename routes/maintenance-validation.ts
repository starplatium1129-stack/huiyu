import type { PathLike } from 'node:fs';
'use strict';

import { PathOrFileDescriptor } from 'node:fs';

let path: typeof import('path') = require('path');


let fs: typeof import('fs') = require('fs');


function readJson(source: PathOrFileDescriptor) {
  return JSON.parse(fs.readFileSync(source, 'utf8'));
}


function writeFileAtomic(source: PathLike, content: string|NodeJS.ArrayBufferView<ArrayBufferLike>) {
  let dir = path.dirname(source);
  fs.mkdirSync(dir, { recursive:true });
  let temporary = path.join(dir, '.' + path.basename(source) + '.' + process.pid + '.' + Date.now() + '.tmp');
  try {
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, source);
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (cleanupError) {}
    throw error;
  }
}


function writeJson(source: unknown, data: unknown) {
  writeFileAtomic(source, JSON.stringify(data, null, 2) + '\n');
}


// ── 2. 校验与文件工具 ──
function uniqueActiveIds(values: unknown, activeIds: { has: (arg0: unknown) => unknown; }) {
  let seen = new Set();
  return (Array.isArray(values) ? values : []).filter(function (id) {
    if (!activeIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}


function sanitizeCuration(value: unknown, activeIds: { has: (arg0: string) => unknown; }, previous: { personaCoreSceneIds: undefined; }) {
  let curation = value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : {};
  curation.curatedSceneIds = uniqueActiveIds(curation.curatedSceneIds, activeIds);
  curation.signatureSceneIds = uniqueActiveIds(curation.signatureSceneIds, activeIds);
  curation.signatureSceneIds.forEach(function (id: unknown) {
    if (curation.curatedSceneIds.indexOf(id) < 0) curation.curatedSceneIds.push(id);
  });
  let curated = new Set(curation.curatedSceneIds);
  curation.reviewSceneIds = uniqueActiveIds(curation.reviewSceneIds, activeIds).filter(function (id) { return !curated.has(id); });
  // personaCoreSceneIds：显式提供时按同一套稳定顺序去重并剔除非活跃引用；
  // 旧请求缺省时由保存链提供当前策展数据，只继承核心精选，不合并其他字段。
  // 未提供旧值时保持缺省；显式 [] 仍表示清空。
  if (curation.personaCoreSceneIds === undefined && previous && previous.personaCoreSceneIds !== undefined) {
    curation.personaCoreSceneIds = previous.personaCoreSceneIds;
  }
  if (curation.personaCoreSceneIds !== undefined) {
    if (!Array.isArray(curation.personaCoreSceneIds)) throw new Error('personaCoreSceneIds 必须是场景 ID 数组');
    curation.personaCoreSceneIds = uniqueActiveIds(curation.personaCoreSceneIds, activeIds);
  }
  let reasons = curation.recommendationReasons && typeof curation.recommendationReasons === 'object' ? curation.recommendationReasons : {};
  curation.recommendationReasons = {};
  Object.keys(reasons).forEach(function (id) {
    if (activeIds.has(id) && String(reasons[id] || '').trim()) curation.recommendationReasons[id] = String(reasons[id]).trim();
  });
  curation.signatureSceneIds.forEach(function (id: string) {
    if (!curation.recommendationReasons[id]) throw new Error(id + ' 标记为招牌场景时必须填写推荐理由');
  });
  return curation;
}


function validateTags(tags: unknown[]) {
  if (!Array.isArray(tags) || tags.length > 2000) throw new Error('Tag 数据格式错误或数量超出限制');
  let ids = new Set();
  let names = new Set();
  tags.forEach(function (tag) {
    let id = String(tag && tag.id || '').trim();
    let name = String(tag && tag.en || '').trim();
    let category = String(tag && tag.cat || '').trim();
    let chinese = String(tag && tag.cn || '').trim();
    let weight = Number(tag && tag.weight);
    if (!/^tag_\d+$/.test(id) || ids.has(id)) throw new Error('Tag ID 必须唯一且符合 tag_001 格式：' + id);
    if (!/^[^\r\n<>]{1,120}$/.test(name) || names.has(name.toLowerCase())) throw new Error('Tag 英文名必须唯一且可用于 Prompt：' + name);
    if (!category || !chinese) throw new Error(id + ' 必须填写分类和中文名');
    if (!Number.isFinite(weight) || weight <= 0 || weight > 2) throw new Error(id + ' 的权重必须在 0 到 2 之间');
    ids.add(id);
    names.add(name.toLowerCase());
  });
}


function decodeJpegDataUrl(value: unknown, label: string) {
  let match = String(value || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw new Error(label + '必须是 JPEG 图片');
  let buffer = Buffer.from(match[1].replace(/\s/g, ''), 'base64');
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) throw new Error(label + '不是有效的 JPEG 文件');
  return buffer;
}
export = { uniqueActiveIds, sanitizeCuration, validateTags, decodeJpegDataUrl, readJson, writeFileAtomic, writeJson };
