const assert: typeof import('assert') = require('assert');
const policy: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');

const { test }: typeof import('node:test') = require('node:test');

test("Prompt policy tests passed: production module, scoped BREAK, ratings, framing and analysis", () => {
const dual = policy.dedupeText('2girls, (ayachi_nene, white_dress, blush) BREAK (shiki_natsume, white_dress, blush)');
assert.strictEqual((dual.match(/white_dress/g) || []).length, 2, 'BREAK scopes must retain repeated attributes for both subjects');
assert.strictEqual((dual.match(/blush/g) || []).length, 2, 'emotion must remain bound to both subjects');

const parts = policy.dedupeParts([
  { cls:'c', text:'1girl, solo, white_hair' },
  { cls:'t', text:'solo, white_hair, smile' },
  { cls:'n', text:'[NEG] bad hands, bad hands' }
]);
assert.strictEqual(parts[1].text, 'smile', 'single-subject global duplicates should be removed');
assert.strictEqual((parts[2].text.match(/bad hands/g) || []).length, 1, 'negative duplicates should be removed');

const enriched = policy.enrichDualPrompt(
  '2girls, cafe, (ayachi_nene_on_the_left, smile) BREAK (shiki_natsume_on_the_right, blush)',
  ['ayachi_nene','white_hair','purple_eyes'],
  ['shiki_natsume','black_hair','yellow_eyes']
);
['ayachi_nene','white_hair','purple_eyes','shiki_natsume','black_hair','yellow_eyes','BREAK'].forEach(token => {
  assert(enriched.includes(token), 'dual prompt should include ' + token);
});

const reframed = policy.filterFraming('close_up, full_body, wide_shot, smile', 'close');
assert(reframed.includes('close_up') && !reframed.includes('full_body') && !reframed.includes('wide_shot'), 'selected framing must override incompatible baseline framing');

const reframedParts = policy.applyFraming([
  { cls:'t', source:'scene', text:'cafe, wide_shot, smile' },
  { cls:'t', source:'manual', text:'full_body, medium_shot, holding_cup' },
  { cls:'t', source:'story', text:'beach, close_up' },
  { cls:'c', source:'tail', text:'establishing_shot, depth_of_field' },
  { cls:'n', text:'[NEG] cropped, bad hands' }
], 'close');
const positiveFramed = reframedParts.filter(part => part.cls !== 'n').map(part => part.text).join(', ');
['wide_shot','full_body','medium_shot','establishing_shot'].forEach(tag => {
  assert(!policy.tokenize(positiveFramed).includes(tag), 'final framing policy must remove stale ' + tag + ' from every positive source');
});
assert(positiveFramed.includes('close_up'), 'selected close framing must survive final composition');
assert(reframedParts.find(part => part.source === 'scene')!.source === 'scene', 'framing policy must retain part metadata');
assert(reframedParts.find(part => part.cls === 'n')!.text.includes('cropped'), 'positive framing policy must not rewrite negative parts');
assert.strictEqual(policy.resolveFramingMode('close', ['wide_shot','full_body']), 'close', 'explicit close shot must override stale wide scene tags for LoRA policy');
assert.strictEqual(policy.resolveFramingMode('pov', ['wide_shot','full_body']), '', 'explicit non-framing shot must not fall back to stale scene framing');
assert.strictEqual(policy.resolveFramingMode('', ['full_body']), 'wide', 'scene tags may drive LoRA framing only before a shot is selected');

const selectiveNegative = policy.mergeNegativePrompt(
  'bad quality, worst detail, sketch',
  'worst quality, bad anatomy, bad hands, crowd, daylight, harsh_lighting, school_uniform',
  'replace',
  'boilerplate'
);
['crowd','daylight','harsh_lighting','school_uniform'].forEach(tag => {
  assert(policy.tokenize(selectiveNegative).includes(tag), 'replace mode must preserve scene semantic exclusion ' + tag);
});
['bad_anatomy','bad_hands'].forEach(tag => {
  assert(!policy.tokenize(selectiveNegative).includes(tag), 'model baseline must replace generic boilerplate ' + tag);
});
assert(policy.tokenize(selectiveNegative).includes('bad quality'), 'model negative baseline must be retained');

const r15 = policy.adaptNegative('bad hands, nsfw, nude, explicit, cropped', { rating:'R15' }, { shot:'close', character:'nene' });
assert(!policy.tokenize(r15).includes('nsfw'), 'R15 must not be blocked by nsfw');
assert(!policy.tokenize(r15).includes('cropped'), 'close-up must not negatively block cropping');
assert(!policy.tokenize(r15).includes('nude') && !policy.tokenize(r15).includes('explicit'), 'R15 must not block explicit content (2026-08-15 用户裁定：R15+ 与 R18 同待遇)');
['child','loli','underage'].forEach(tag => assert(policy.tokenize(r15).includes(tag), 'R15 must exclude ' + tag));

const r18 = policy.adaptNegative('bad hands, nsfw, nude, explicit', { rating:'R18', mature:true }, { character:'nene' });
['child','loli','underage'].forEach(tag => assert(policy.tokenize(r18).includes(tag), 'R18 must exclude ' + tag));
['nsfw','nude','explicit'].forEach(tag => assert(!policy.tokenize(r18).includes(tag), 'R18 negative must not fight ' + tag));

const report = policy.analyzeParts([{ cls:'t', text:'1girl, close_up, wide_shot, smile' }, { cls:'n', text:'[NEG] bad hands' }]);
assert.strictEqual(report.level, 'warn', 'conflicting framing should be reported');
assert(report.warnings.some(message => message.includes('镜头')), 'framing warning should be actionable');

// 词条搭配：质量词堆叠 / 服装冲突 / 时段冲突 / 天气冲突
const qualityStack = policy.analyzeParts([{ cls:'q', text:'masterpiece, best quality, amazing quality, very aesthetic, absurdres, newest, highres, highly detailed, 1girl' }]);
assert(qualityStack.warnings.some(message => message.includes('质量词过多')), 'stacked quality tokens should warn');

const outfitConflict = policy.analyzeParts([{ cls:'t', text:'school_uniform, swimsuit, kimono, smile' }]);
assert(outfitConflict.warnings.some(message => message.includes('服装相互冲突')), 'outfit families should warn when mixed');

const timeConflict = policy.analyzeParts([{ cls:'t', text:'day, night, smile' }]);
assert(timeConflict.warnings.some(message => message.includes('时段相互冲突')), 'day and night should conflict');

const weatherConflict = policy.analyzeParts([{ cls:'t', text:'rain, clear_sky, smile' }]);
assert(weatherConflict.warnings.some(message => message.includes('天气相互冲突')), 'rain and clear sky should conflict');

const coherent = policy.analyzeParts([{ cls:'t', text:'night, moonlight, rain, wet, standing, 1girl, solo, umbrella, city_lights, medium_shot, smile' }]);
assert(!coherent.warnings.some(message => message.includes('时段')), 'moonlight belongs to night family');
assert(!coherent.warnings.some(message => message.includes('天气')), 'rain without conflicting sky should not warn');

const goldenAfternoon = policy.analyzeParts([{ cls:'t', text:'afternoon, golden hour, school_uniform, smile' }]);
assert(!goldenAfternoon.warnings.some(message => message.includes('时段')), 'golden hour belongs to the afternoon/evening family');

// Anima uses natural-language tags, but score tags and BREAK remain protocol tokens.
const animaPrompt = policy.formatPromptForEngine(
  'masterpiece, best quality, score_7, safe, (white_hair:1.1), BREAK (black_hair:1.1), <lora:ignored:0.7>',
  'anima',
);
assert.strictEqual(
  animaPrompt,
  'masterpiece, best quality, score_7, safe, (white hair:1.1) BREAK (black hair:1.1)',
  'Anima formatting must convert ordinary tags, preserve score tags, preserve BREAK scopes, and strip A1111 LoRA syntax',
);
assert.strictEqual(
  policy.formatPromptForEngine('white_hair, best_quality', 'sd'),
  'white_hair, best_quality',
  'SD formatting must retain the existing underscore contract',
);
assert.strictEqual(
  policy.formatPromptForEngine('white_hair, <lora:nene:0.85>', 'sd'),
  'white_hair, <lora:nene:0.85>',
  'SD formatting must retain A1111 LoRA syntax for the existing WebUI path',
);
const engineProfiles: any[] = [
  { id:'sd', engine:'sd', match:['shared-model'], quality_prefix:'sd quality' },
  { id:'anima', engine:'anima', model_id:'anima-base-v1.0', match:['shared-model'], tag_style:'space' },
];
assert.strictEqual(
  policy.resolveModelProfile!(engineProfiles, 'anima-base-v1.0', 'anima')!.id,
  'anima',
  'Anima profile lookup must not fall back to an SD profile',
);
assert.strictEqual(
  policy.modelNegativePrompt(
    { engine:'anima', negative_prefix:'worst quality, score_1, artist name', negative_mode:'merge' },
    'blurry, chromatic aberration, score_1',
    'anima',
  ),
  'worst quality, score_1, artist name, blurry, chromatic aberration',
  'Anima negative prompts must preserve score exceptions while formatting ordinary tags',
);
assert.strictEqual(
  policy.sceneTemplateText(
    { prompt:'cafe, white_hair, score_7, <lora:ignored:0.7>' },
    { engine:'anima' },
  ),
  'cafe, white hair, score_7',
  'Anima scene templates must use the same tag policy as manually assembled prompts',
);
const presetProfiles: any[] = (require('../../data/presets.json') as typeof import('../../data/presets.json')).model_profiles;
const animaBase = presetProfiles.find(profile => profile.id === 'anima_base_v10');
const animaAesthetic = presetProfiles.find(profile => profile.id === 'anima_aesthetic_v11');
const neneContract: any = (require('../../data/loras.json') as typeof import('../../data/loras.json')).find!(lora => lora.id === 'L_NENE_V21_ANIMA')!.prompt_contract;
assert(animaBase && animaAesthetic, 'Anima Base and Aesthetic profiles must be present in the production catalog');
for (const profile of [animaBase, animaAesthetic]) {
  assert.deepStrictEqual(profile.exact_tokens, [], 'model profiles keep no family-level exact tokens; LoRA contracts own them');
}
const exactV19 = policy.formatPromptForProfile(
  'ayachi_nene, nene_r18, nene_witch_canonical, nene_school_uniform, white_hair, very_long_hair, low_twintails, purple_eyes, warm_lighting',
  Object.assign({}, animaBase, neneContract),
);
['ayachi_nene', 'nene_r18', 'nene_witch_canonical', 'nene_school_uniform', 'white_hair', 'very_long_hair', 'low_twintails', 'purple_eyes'].forEach(token => {
  assert(exactV19.includes(token), 'v19 exact control token must not be rewritten: ' + token);
});
assert(exactV19.includes('warm lighting'), 'ordinary scene and lighting tags should still use spaces');
assert.strictEqual(policy.resolveModelProfile(presetProfiles, 'unknown-krea-model', 'krea2'), null, 'unknown Krea models must fail closed');
assert.strictEqual(policy.resolveModelProfile(presetProfiles, 'anima-yume-v2.0', 'anima'), null, 'unlisted Anima models must fail closed');
const yumeProfile = policy.resolveModelProfile(presetProfiles, 'anima-yume-v1.0', 'anima');
assert(yumeProfile && yumeProfile.id === 'anima_yume_v10', 'AnimaYume (reviewed 2026-08-15) must resolve to its own profile, not fall back to Base');
assert.strictEqual(yumeProfile.quality_prefix, 'masterpiece, best quality, score_7', 'Yume keeps the Base-quality prefix');
assert(policy.qualityPrefix(animaBase, { rating:'ALL' }, 'anima').includes('score_7'), 'Anima Base must retain its score quality prefix');
assert(policy.qualityPrefix(animaBase, { rating:'ALL' }, 'anima').includes('best quality'), 'Anima Base must keep best quality with official spaces');
assert.strictEqual(policy.qualityPrefix(animaAesthetic, { rating:'ALL' }, 'anima'), 'safe', 'Anima Aesthetic must add only its rating tag when the quality prefix is intentionally empty');
for (const profile of [animaBase, animaAesthetic]) {
  const negative = policy.modelNegativePrompt(profile, 'bad anatomy, crowd', 'anima');
  assert(negative.includes('crowd'), `${profile.id} must preserve scene semantic negatives`);
  assert(!negative.includes('bad anatomy'), `${profile.id} must replace generic boilerplate negatives`);
  assert.strictEqual(profile.lora_in_prompt, false, `${profile.id} must keep LoRA outside the Anima prompt`);
}

assert(policy.sceneSupportsCharacter({ char:'nene' }, 'nene'));
assert(!policy.sceneSupportsCharacter({ char:'nene' }, 'natsume'));
assert.strictEqual(
  policy.sceneTemplateText({ prompt:'cafe, school_uniform', tags:['school_uniform'] }, {}),
  'cafe, school_uniform',
  'scene template text must retain scene identity tags because metadata is not appended to the final prompt'
);

const natsumeSoloTemplate = policy.sceneTemplateText({
  prompt:'1girl, solo, shiki_natsume, black_hair, long_hair, yellow_eyes, mole_under_eye, hairclip, holding_hands, straddling_viewer, (POV male hand around her waist:1.5), cafe, warm_lighting',
}, { char:'natsume' });
['cafe', 'warm_lighting', 'holding_hands', 'straddling_viewer'].forEach(token => {
  assert(policy.tokenize(natsumeSoloTemplate).includes(token), 'Natsume solo scenes must retain direction and viewer interactions ' + token);
});
['1girl', 'solo', 'shiki_natsume', 'black_hair', 'long_hair', 'yellow_eyes', 'mole_under_eye', 'hairclip', 'male'].forEach(token => {
  assert(!natsumeSoloTemplate.includes(token), 'Natsume solo scenes must remove redundant identity and explicit male subject ' + token);
});

assert.deepStrictEqual(
  policy.characterControlTokens(
    { prompt:'ayachi_nene, official_witch_outfit, bedroom', rating:'R18', mature:true },
    'nene',
    { nene:'ayachi_nene_v18_wd14' }
  ),
  [
    'nene_r18', 'nene_witch_canonical', 'witch_hat', 'black_cape',
    'criss-cross_halter', 'crop_top', 'strap_between_breasts', 'pink_bow',
    'pink_ribbon', 'black_skirt', 'asymmetrical_legwear',
    'striped_thighhighs', 'single_thighhigh', 'single_sock', 'frilled_socks',
    'midriff'
  ],
  'v18 mature witch scenes must receive the adult gate and exact trained outfit bundle'
);
assert.deepStrictEqual(
  policy.characterControlTokens(
    { prompt:'ayachi_nene, navy_blazer, school_uniform' },
    'nene',
    { nene:'ayachi_nene_v18_wd14' }
  ),
  [
    'nene_school_uniform', 'school_uniform', 'blazer', 'yellow_bowtie',
    'plaid_skirt', 'pleated_skirt', 'grey_skirt', 'black_thighhighs',
    'zettai_ryouiki'
  ],
  'canonical school scenes must receive the exact trained uniform bundle'
);
assert.deepStrictEqual(
  policy.characterControlTokens(
    { prompt:'shiki_natsume, qipao, standing' },
    'natsume',
    { natsume:'shiki_natsume_v18_wd14' }
  ),
  [
    'natsume_official_qipao', 'chinese_clothes', 'china_dress', 'red_dress',
    'floral_print', 'side_slit', 'long_sleeves', 'black_thighhighs',
    'hair_bun', 'double_bun', 'hair_flower', 'red_flower'
  ],
  'official qipao scenes must use the exact v18 caption vocabulary'
);
assert.deepStrictEqual(
  policy.characterControlTokens(
    { prompt:'shiki_natsume, cafe_uniform, closed_cafe' },
    'natsume',
    { natsume:'shiki_natsume_v18_wd14' }
  ),
  [
    'natsume_cafe_uniform', 'white_shirt', 'suspenders', 'suspender_skirt',
    'brown_skirt', 'long_sleeves', 'collared_shirt', 'purple_ribbon',
    'hair_flower'
  ],
  'official cafe scenes must use the exact v18 caption vocabulary'
);
assert.deepStrictEqual(
  policy.characterControlTokens(
    { prompt:'ayachi_nene, nightgown', rating:'R18', mature:true },
    'nene',
    { nene:'ayachi_nene_v15' }
  ),
  [],
  'legacy models must not receive control words they never learned'
);
const v19Controls = policy.characterControlTokens(
  { prompt:'ayachi_nene, nene_school_uniform', rating:'R18', mature:true },
  'nene',
  { nene:'ayachi_nene_v21_anima' },
);
['nene_r18', 'nene_school_uniform', 'school_uniform', 'blazer', 'yellow_bowtie', 'plaid_skirt'].forEach(token => {
  assert(v19Controls.includes(token), 'v19 control bundle must retain exact token ' + token);
});
const migratedLora = policy.resolveLoraSpecs(
  'nene',
  { lora:'ayachi_nene_v15:0.85' },
  [{ name:'ayachi_nene_v18_wd14', strength:{ default:0.85 } }],
  { nene:'ayachi_nene_v18_wd14' }
);
assert.strictEqual(migratedLora[0].name, 'ayachi_nene_v18_wd14', 'legacy scene LoRA ids must resolve to the promoted model');

// 单人引擎（Anima/Krea）场景净化：只删明确可见的额外主体/人数词；
// POV、望向镜头、牵手、浪漫氛围与中心互动动作全部保留。
const dirty = '(male arms embracing her from behind:1.55), one hand pulling the curtain closed, back_hug, holding_hands, kiss, cohabitation, 1girl, solo, ayachi_nene, night, window_light, silhouette, sleepwear, 2girls, 1boy';
const solo = policy.sanitizeSoloTemplate(dirty);
['male', '1boy', '2girls'].forEach(word => {
  assert(!policy.tokenize(solo).some(t => t.includes(word.replace(/_/g, ' ')) || t.includes(word)), 'solo engine must drop explicit visible extra-subject/count token ' + word);
});
assert(!/\([^)]*\)/.test(solo), 'solo engine must strip weighted-parenthesis phrases that name an extra subject');
['1girl', 'solo', 'ayachi_nene', 'night', 'window_light', 'sleepwear', 'back_hug', 'holding_hands', 'kiss', 'cohabitation', 'silhouette'].forEach(word => {
  assert(policy.tokenize(solo).some(t => t.includes(word)), 'solo engine must preserve ' + word);
});
// SD 引擎不受影响：sceneTemplateText 在 sd 下保留互动词（WebUI 支持双人）。
const sdScene = policy.sceneTemplateText({ prompt: dirty }, { char: 'nene', engine: 'sd' });
assert(sdScene.includes('back_hug') || sdScene.includes('back hug'), 'SD engine must keep dual-interaction scene words');
const animaScene = policy.sceneTemplateText({ prompt: dirty }, { char: 'nene', engine: 'anima' });
assert(!animaScene.includes('male arms'), 'Anima engine must drop explicit male-subject phrases');
assert(animaScene.includes('back hug') || animaScene.includes('back_hug'), 'Anima engine must preserve central interactions');

});
