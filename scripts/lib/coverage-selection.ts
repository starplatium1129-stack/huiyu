'use strict';

/**
 * scripts/lib/coverage-selection.js — audit:coverage 的 --character/--outfit 筛选纯辅助。
 *
 * 职责边界（G9）：
 *   - 解析并校验筛选参数：--outfit 必须与 --character 同时出现；未知角色/服装抛出
 *     明确参数错误，不得退化为貌似正常的空报告。角色/服装「已知」以其出现在
 *     characters.json、热门分片或参考登记（standards/view）任一来源为准；
 *     规范 ID 之外的旧别名不自动解析，只给提示。
 *   - 计算所选范围的参考 URL 集合并包装 fileExists：范围外 URL 一律返回
 *     null（无法核实），不触碰磁盘，保证未选角色的素材文件不被 stat，
 *     也不会被计为 verified。
 *   - 从全库分析结果中筛出所选范围的条目级结果并重算数量；结构错误与
 *     mirrorErrors/duplicate* 等全域字段原样保留（全域问题不一定由所选对象造成）。
 *
 * 本模块不读文件系统、不执行命令；输入输出均为普通对象/Map/Set。
 */

/** 解析 --character/--outfit；无 --character 时返回 null（全库模式）。
 *  语法不合法（缺值、--outfit 单独出现）抛 Error，由调用方按参数错误处理。 */
function parseSelectionArgs(argv: string|string[]) {
  for (const arg of argv) {
    if (/^--(?:character|outfit)=/.test(arg)) throw new Error('筛选参数需使用 --character <ID> / --outfit <ID>');
  }
  const readFlag = (flag: string) => {
    const index = argv.indexOf(flag);
    if (index < 0) return { present: false };
    if (argv.indexOf(flag, index + 1) >= 0) throw new Error(`${flag} 不能重复指定`);
    const value = argv[index + 1];
    if (value === undefined || !String(value).trim() || String(value).startsWith('--')) throw new Error(`${flag} 需要一个 ID 值`);
    return { present: true, value: String(value) };
  };
  const character = readFlag('--character');
  const outfit = readFlag('--outfit');
  if (outfit.present && !character.present) throw new Error('--outfit 必须与 --character 同时使用');
  if (!character.present) return null;
  return { character: character.value, outfit: outfit.present ? outfit.value : null };
}

/** 汇总身份全集：characters.json、热门分片行、standards、view 中出现过的角色/服装。 */
function collectKnownIds({ characters, popularCharacters = [], popularRows, standards, view }: any) {
  const characterIds = new Set();
  const outfitsByCharacter = new Map();
  const addOutfit = (id: any, outfitId: any) => {
    if (!outfitsByCharacter.has(id)) outfitsByCharacter.set(id, new Set());
    outfitsByCharacter.get(id).add(outfitId);
  };
  for (const record of characters) if (record?.id) characterIds.add(record.id);
  for (const record of popularCharacters) if (record?.id) characterIds.add(record.id);
  for (const row of popularRows) { characterIds.add(row.id); addOutfit(row.id, row.outfitId); }
  for (const record of standards) { characterIds.add(record.id); for (const outfitId of record.outfitIds) addOutfit(record.id, outfitId); }
  for (const record of view) { characterIds.add(record.id); for (const outfit of record.outfits) addOutfit(record.id, outfit.outfitId); }
  return { characterIds, outfitsByCharacter };
}

/** 校验所选角色/服装存在；未知则抛出带定位信息的参数错误。
 *  aliasMap（normalize 别名 → 规范 ID）可选，仅用于给旧别名一个可行动的提示，
 *  不做自动改写。 */
function assertSelectionKnown(selection: any, known: any, aliasMap: any) {
  const { character, outfit } = selection;
  if (!known.characterIds.has(character)) {
    const suggestion = aliasMap?.get(character);
    const hint = suggestion ? `（"${character}" 不是规范 ID，疑似 ${suggestion} 的别名/旧选择器，请改用规范 ID）` : '（--character 需为 characters.json、热门分片或参考登记中已有的规范 ID）';
    throw new Error(`未知角色 ID "${character}"${hint}`);
  }
  if (outfit && !known.outfitsByCharacter.get(character)?.has(outfit)) {
    throw new Error(`角色 ${character} 无服装 ID "${outfit}"（--outfit 需为该角色在热门分片或参考登记中已有的形态 ID）`);
  }
}

/** 所选范围在 view 中声明的参考 URL 集合；调用方仍需校验 URL 所属条目。 */
function collectScopedRefUrls({ view, character, outfit }: any) {
  const urls = new Set();
  for (const record of view) {
    if (record.id !== character) continue;
    for (const entry of record.outfits) {
      if (outfit && entry.outfitId !== outfit) continue;
      for (const ref of entry.references) if (ref.url) urls.add(ref.url);
    }
  }
  return urls;
}

/** 包装 fileExists：范围外 URL 直接返回 null（未核实），不调用底层实现。 */
function scopeFileExists(fileExists: any, scopedUrls: any, selection?: any) {
  return (url: any, owner: any) => {
    if (selection && (!owner || owner.id !== selection.character
      || (selection.outfit && owner.outfitId !== selection.outfit))) return null;
    return scopedUrls.has(url) ? fileExists(url) : null;
  };
}

/** scope 元数据：机器可读地声明局部报告的口径。 */
function describeScope(selection: any) {
  return {
    mode: selection.outfit ? 'character-outfit' : 'character',
    character: selection.character,
    outfit: selection.outfit || null,
    coverageCountsScope: 'selected',
    structuralChecksScope: 'all',
    unselectedReferenceFilesChecked: false,
  };
}

/** 从全库分析结果筛出所选范围：条目级数组按 id/outfitId 过滤（数量随之重算），
 *  结构性字段（mirrorErrors、duplicate*、duplicateRegistrations）保留全库结果；
 *  verifiedImage 已由范围化 fileExists 保证只统计所选范围真实核对过的图片。
 *  主题只保留所选角色自身的状态；staleAlias/nonCharacter 属全库信息，局部不列出。 */
function filterReportToScope(report: any, selection: any) {
  const { character, outfit } = selection;
  const inScope = (row: any) => row.id === character && (!outfit || row.outfitId === outfit);
  const reference = report.reference;
  const scopedReference = {
    missingRegistration: reference.missingRegistration.filter(inScope),
    pending: reference.pending.filter(inScope),
    missingImage: reference.missingImage.filter(inScope),
    unverifiedImage: reference.unverifiedImage.filter(inScope),
    referenceOnlyForms: reference.referenceOnlyForms.filter(inScope),
    verifiedImage: reference.verifiedImage,
    mirrorErrors: reference.mirrorErrors,
    duplicateCharacters: reference.duplicateCharacters,
    duplicateOutfits: reference.duplicateOutfits,
    duplicateRegistrations: reference.duplicateRegistrations,
  };
  const themes = report.themes;
  const scopedThemes = {
    explicit: themes.explicit.filter((id: any) => id === character),
    defaultAllowed: themes.defaultAllowed.filter((id: any) => id === character),
    missingTheme: themes.missingTheme.filter((row: any) => row.id === character),
    staleAlias: [],
    nonCharacter: [],
    dupCharacters: themes.dupCharacters,
  };
  return {
    version: report.version,
    scope: describeScope(selection),
    structuralErrors: report.structuralErrors,
    reference: scopedReference,
    themes: scopedThemes,
  };
}

export = {
  parseSelectionArgs,
  collectKnownIds,
  assertSelectionKnown,
  collectScopedRefUrls,
  scopeFileExists,
  describeScope,
  filterReportToScope,
};
