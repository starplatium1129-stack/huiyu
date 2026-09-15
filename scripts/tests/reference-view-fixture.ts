'use strict';

// Neutral runtime projection with the same shape as the published view contract.
function referenceView({ firstUrl = '', retainedUrl = '' }: any = {}) {
  const perspectives = ['ref_01_face_closeup', 'ref_02_half_medium', 'ref_03_full_dynamic', 'ref_04_back_rear'];
  return { fixture: { characterId: 'fixture', displayName: 'Fixture', source: 'Test',
    identityProse: 'An adult test character.', outfits: [{ outfitId: 'coat', outfitName: 'Blue coat',
      isDefault: true, isNsfw: false, prose: 'A blue coat.', references: perspectives.map((id, index) => {
        const url = index === 0 ? firstUrl : index === 1 ? retainedUrl : '';
        return { id, name: 'Reference ' + (index + 1), shotType: 'medium shot', lens: '50mm',
          targetUsage: ['character reference'], fileName: url ? url.split('/').at(-1) : id + '.png',
          url, pending: !url };
      }) }] } };
}

export = { referenceView };
