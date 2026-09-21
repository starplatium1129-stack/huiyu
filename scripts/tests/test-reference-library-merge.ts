import assert = require('node:assert/strict');
import { mergeReferenceLibrary } from '../lib/reference-library-merge';

const existing = {
  standards: { version: 2, perspectives: [{ id: 'front', name: 'Curated' }], characters: [
    { id: 'alice', identityProse: 'Curated identity', outfits: [{ id: 'dress', tokens: ['curated'] }, { id: 'pending', tokens: ['keep'] }] },
    { id: 'custom', outfits: [] },
  ] },
  view: { alice: { characterId: 'alice', outfits: [
    { outfitId: 'dress', references: [
      { id: 'front', url: '/reviewed.png', reviewStatus: 'approved', sha256: 'abc' },
      { id: 'back', url: '', pending: true, reviewStatus: 'awaiting-review' },
      { id: 'design', url: '/design.png', reviewStatus: 'approved' },
    ] },
    { outfitId: 'pending', references: [{ id: 'front', pending: true, url: '' }] },
  ] }, custom: { characterId: 'custom', outfits: [] } },
};
const discovered = {
  standards: { version: 2, perspectives: [{ id: 'front', name: 'Generated' }, { id: 'new' }], characters: [
    { id: 'alice', identityProse: 'Generated identity', outfits: [{ id: 'dress', tokens: ['generated'] }, { id: 'new' }] },
    { id: 'bob', outfits: [] },
  ] },
  view: { alice: { characterId: 'alice', outfits: [
    { outfitId: 'dress', references: [
      { id: 'front', url: '/regenerated.png' },
      { id: 'back', url: '/found-back.png' },
      { id: 'design', url: '', pending: true },
    ] },
    { outfitId: 'new', references: [{ id: 'front', url: '/new.png' }] },
  ] }, bob: { characterId: 'bob', outfits: [] } },
};
const snapshot = JSON.stringify(existing);
const result = mergeReferenceLibrary(existing, discovered);
assert.equal(JSON.stringify(existing), snapshot, 'merge must not mutate inputs');
assert.deepEqual(result.standards.characters.map((c: any) => c.id), ['alice', 'custom', 'bob']);
assert.deepEqual(result.standards.characters[0].outfits.map((o: any) => o.id), ['dress', 'pending', 'new']);
assert.deepEqual(result.standards.characters[0].outfits[0].tokens, ['curated']);
assert.equal(result.standards.characters[0].identityProse, 'Curated identity');
assert.equal(result.standards.perspectives[0].name, 'Curated');
const refs = result.view.alice.outfits[0].references;
assert.deepEqual(refs[0], existing.view.alice.outfits[0].references[0]);
assert.equal(refs[1].url, '/found-back.png');
assert.equal(refs[1].pending, undefined);
assert.equal(refs[1].reviewStatus, 'awaiting-review');
assert.equal(refs[2].url, '/design.png');
assert.equal(refs[2].pending, undefined, 'a discovered placeholder must not demote an existing asset');
assert.deepEqual(result.view.alice.outfits[1], existing.view.alice.outfits[1]);
assert.deepEqual(mergeReferenceLibrary(result, discovered), result, 'asset refresh is idempotent');
console.log('PASS reference-library merge preserves pending outfits, curated text, URLs and review metadata');
