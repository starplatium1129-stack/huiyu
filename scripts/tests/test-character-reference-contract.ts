'use strict';

/** 角色参考资产库机器契约（AGENTS.md 数据边界 + 2026-08-28 审计立项）：
 *  把原先散落在 sync-multi-outfit-standards.js / render-all-outfits-references.js
 *  等维护脚本里各写一份的 4 视角手写字段清单，收口为 JSON Schema + 交叉校验。
 *
 *  两份执行契约：
 *  1. 结构契约（ajv + scripts/contracts/*.schema.json）——
 *     standards.json（手写权威源）与 view.json（前端懒加载产物）各自通过 schema；
 *  2. 镜像契约（独立 oracle，不信任 schema 内联）——
 *     view 的每条参考的 name/shotType/lens/targetUsage 必须逐字段等于
 *     standards 同 id 视角定义；角色/服装/默认形态集合双向一致。
 *     任何一侧漂移（如渲染脚本复制旧视角字段）都在 test:contract 阶段爆红。
 */
const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const test: typeof import('node:test') = require('node:test');
const Ajv: typeof import('ajv') = require('ajv');

const root = path.resolve(__dirname, '..', '..');
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(root, ...parts), 'utf8'));

const standards = readJson('data', 'character-reference-standards.json');
const view = readJson('data', 'character-reference-view.json');
const standardsSchema = readJson('scripts', 'contracts', 'character-reference-standards.schema.json');
const viewSchema = readJson('scripts', 'contracts', 'character-reference-view.schema.json');

const ajv = new Ajv({ allErrors: true });
const validateStandards = ajv.compile(standardsSchema);
const validateView = ajv.compile(viewSchema);

const PERSPECTIVE_IDS = standards.perspectives.map((p: any) => p.id);

test('character reference standards: passes JSON Schema contract', () => {
  const ok = validateStandards(standards);
  assert.ok(ok, ajv.errorsText(validateStandards.errors, { separator: '\n  ' }));
});

test('character reference view: passes JSON Schema contract', () => {
  const ok = validateView(view);
  assert.ok(ok, ajv.errorsText(validateView.errors, { separator: '\n  ' }));
});

test('character reference view: character set mirrors standards (both directions)', () => {
  const standardsIds = standards.characters.map((c: any) => c.id).sort();
  const viewIds = Object.keys(view).sort();
  assert.deepEqual(viewIds, standardsIds,
    'view.json 的角色集合必须与 standards.json 双向一致（孤儿/缺失都是漂移）');
  for (const character of standards.characters) {
    assert.equal(view[character.id].characterId, character.id,
      `${character.id}: view.characterId 与键名不一致`);
  }
});

test('character reference view: outfit set mirrors standards (both directions)', () => {
  for (const character of standards.characters) {
    const standardsOutfits = character.outfits.map((o: any) => o.id).sort();
    const viewOutfits = view[character.id].outfits.map((o: any) => o.outfitId).sort();
    assert.deepEqual(viewOutfits, standardsOutfits,
      `${character.id}: 服装形态集合双向不一致`);
  }
});

test('character reference view: exactly one default outfit per character, mirrored flags', () => {
  for (const character of standards.characters) {
    const defaults = character.outfits.filter((o: any) => o.isDefault === true);
    // 2026-08-31：无参考资产的角色（sync 幽灵形态过滤后 outfits 为空，待 reference:render
    // 渲染 4 视角资产后由 sync 填充）允许 0 个 default；有资产时仍必须恰好 1 套。
    assert.ok(defaults.length <= 1,
      `${character.id}: standards 最多一套 isDefault 服装（isNsfw 私密形态不接管默认位）`);
    if (character.outfits.length > 0) {
      assert.equal(defaults.length, 1,
        `${character.id}: 有资产的角色必须恰好一套 isDefault 服装`);
    }
    for (const outfit of character.outfits) {
      const viewOutfit = view[character.id].outfits.find((o: any) => o.outfitId === outfit.id);
      assert.equal(viewOutfit.isDefault, outfit.isDefault === true,
        `${character.id}/${outfit.id}: isDefault 镜像不一致`);
      assert.equal(viewOutfit.isNsfw, outfit.isNsfw === true,
        `${character.id}/${outfit.id}: isNsfw 镜像不一致`);
    }
  }
});

test('character reference view: references are the canonical perspectives in order, fields mirrored', () => {
  for (const character of standards.characters) {
    for (const outfit of view[character.id].outfits) {
      const ids = outfit.references.map((r: any) => r.id);
      assert.deepEqual(ids, PERSPECTIVE_IDS,
        `${character.id}/${outfit.outfitId}: 参考视角必须恰为 standards 定义的标准视角且顺序稳定`);
      for (const reference of outfit.references) {
        const standard = standards.perspectives.find((p: any) => p.id === reference.id);
        for (const field of ['name', 'shotType', 'lens', 'targetUsage']) {
          assert.deepEqual(reference[field], standard[field],
            `${character.id}/${outfit.outfitId}/${reference.id}: ${field} 与 standards 视角定义漂移`);
        }
      }
    }
  }
});

test('character reference view: identityProse mirrors standards', () => {
  for (const character of standards.characters) {
    assert.equal(view[character.id].identityProse, character.identityProse,
      `${character.id}: identityProse 与 standards 漂移`);
  }
});

test('character reference view: urls use external /character-references/ prefix (2026-08-29 迁移)', () => {
  for (const character of Object.values(view)) {
    for (const outfit of character.outfits || []) {
      for (const ref of outfit.references || []) {
        // 2026-08-31 设计图基线占位：pending 无 url（图未生成），跳过；生成后填 url 走外部前缀。
        if (ref.pending) continue;
        assert.ok(ref.url.startsWith('/character-references/'),
          `${character.characterId}/${outfit.outfitId}/${ref.id}: url 必须走外部目录前缀 /character-references/（参考图已迁 AI 工作区）`);
      }
    }
  }
});


test('reference asset audit shares gateway roots, rejects missing URLs and directories', (t) => {
  const os: typeof import('node:os') = require('node:os');
  const { auditReferenceView }: typeof import('../maintenance/check-ref-urls') = require('../maintenance/check-ref-urls');
  const { resolveCharRefRoot }: typeof import('../../server/config') = require('../../server/config');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-ref-root-'));
  t.after(() => {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const custom = path.join(temp, 'custom');
  const legacy = path.join(temp, 'assets', 'character-references');
  fs.mkdirSync(custom); fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(custom, 'face.png'), 'fixture');
  fs.writeFileSync(path.join(legacy, 'face.png'), 'fixture');
  const view = (refs: any) => ({ example: { outfits: [{ outfitId: 'default', references: refs }] } });
  const modern = view([{ url: '/character-references/face.png' }, { pending: true }]);
  assert.equal(resolveCharRefRoot(temp, {}, ''), legacy);
  assert.equal(auditReferenceView(modern, temp, {}).missing, 0);
  const explicit = { AICS_CHARACTER_REF_ROOT: custom };
  assert.equal(auditReferenceView(modern, temp, explicit).refRoot, resolveCharRefRoot(temp, explicit));
  assert.equal(auditReferenceView(modern, temp, explicit).pending, 1);
  assert.equal(auditReferenceView(view([{ url: '/assets/character-references/face.png' }]), temp, {}).missing, 0);
  const invalid = view([{}, { url: '/character-references/%2e%2e/face.png' }, { url: '/character-references/' }]);
  assert.equal(auditReferenceView(invalid, temp, explicit).missing, 3);
  assert.equal(auditReferenceView(modern, temp, { AICS_CHARACTER_REF_ROOT: path.join(temp, 'absent') }).missing, 1);
  const ciAudit = auditReferenceView(modern, temp, {
    AICS_CHARACTER_REF_ROOT: path.join(temp, 'absent'),
    AICS_REFERENCE_AUDIT_MODE: 'structure',
  });
  assert.equal(ciAudit.missing, 0, 'CI structure mode cannot require intentionally untracked external media');
  assert.equal(ciAudit.unverified, 1);
  assert.equal(auditReferenceView(invalid, temp, { AICS_REFERENCE_AUDIT_MODE: 'structure' }).missing, 3,
    'structure mode must still reject missing, traversal, and empty URLs');
  assert.equal(resolveCharRefRoot(temp, { AICS_CHARACTER_REF_ROOT: path.join(custom, 'face.png') }), '');
});
