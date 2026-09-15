'use strict';

/**
 * Shared semantic policy for scene prompts.
 *
 * Keep this module dependency-free: it is used by the classifier, optimizer
 * and validation gate, so every maintenance command evaluates the same rules.
 */

const R18_TAGS = new Set([
  'naked', 'nude', 'naked_apron', 'no_panties', 'straddling_viewer',
  'extreme_intimacy', 'ecstasy', 'bound_to_bed', 'bikini_malfunction',
  'untied_swimsuit', 'legs_wrapped_around_viewer'
]);

const R15_TAGS = new Set([
  'lingerie', 'lace_lingerie', 'cleavage', 'no_bra', 'bath_towel', 'straddling',
  'neck_kiss', 'bound', 'micro_bikini', 'string_bikini', 'brassiere_visible',
  'bridal_lingerie', 'virgin_killer_sweater', 'backless',
  'nipples_visible_through_clothing', 'see_through_clothing',
  'transparent_clothing', 'sensual', 'sideboob', 'skirt_lift', 'shirt_lift',
  'shirt_undone', 'unbuttoned_shirt', 'open_shirt', 'shirt_slid_down',
  'undressing', 'towel_slip', 'loose_towel', 'wet_shirt', 'tight_clothing',
  'underwear', 'underwear_strap', 'disheveled_clothes'
]);

const R18_STORY = [
  /\u88f8\u4f53|\u5168\u88f8|\u4e00\u4e1d\u4e0d\u6302|\u4e0d\u7740\u5bf8\u7f15/,
  /\u6027\u884c\u4e3a|\u63d2\u5165|\u5c04\u7cbe/,
  /\u88d9.{0,10}(?:\u6380|\u64a9|\u6ed1).{0,10}\u8170/,
  /\u91cc\u9762\u7a7a\u65e0\u4e00\u7269/,
  /\u968f\u4f60\u628a\u6211\u574f\u6389|\u5f7b\u5e95\u968f\u4f60/
];

const R15_STORY = [
  /\u5de5\u53e3|\u60c5\u6b32/,
  /\u5a07\u5598|\u547b\u541f/,
  /\u9165\u80f8|\u80f8\u53e3.{0,12}\u66b4\u9732/,
  /\u88ab\u8feb.{0,16}(?:\u6362\u4e0a|\u8dea)|\u60e9\u7f5a.{0,16}\u8dea/
];

const YOUTH_UNIFORM_TAGS = new Set([
  'school_uniform', 'gym_uniform', 'serafuku', 'sailor_uniform'
]);

const ADULT_SAFETY_NEGATIVE = ['child', 'loli', 'underage'];

function tokenKey(value: unknown) {
  let token = String(value || '').trim().toLowerCase();
  if (!token || /^<lora:/i.test(token) || /^break$/i.test(token)) return token;
  token = token.replace(/^[\s([{]+/, '').replace(/[\s)\]}]+$/, '');
  token = token.replace(/:([0-9]*\.)?[0-9]+$/, '');
  return token.trim().replace(/[\s-]+/g, '_');
}

function splitPromptSegments(prompt: unknown) {
  return String(prompt || '')
    .split(/\s*,?\s*\bBREAK\b\s*,?\s*/i)
    .map((segment) => segment.split(',').map((token) => token.trim()).filter(Boolean));
}

function promptTokenKeys(prompt: unknown) {
  return splitPromptSegments(prompt).flat().map(tokenKey).filter(Boolean);
}

function scenePositiveKeys(scene: any) {
  return new Set([
    ...(Array.isArray(scene && scene.tags) ? scene.tags.map(tokenKey) : []),
    ...promptTokenKeys(scene && scene.prompt)
  ].filter(Boolean));
}

function ratingFor(scene: any) {
  const keys = scenePositiveKeys(scene);
  const story = [scene && scene.title, scene && scene.story].join(' ').toLowerCase();
  if ([...R18_TAGS].some((tag) => keys.has(tag)) || R18_STORY.some((pattern) => pattern.test(story))) return 'R18';
  if ([...R15_TAGS].some((tag) => keys.has(tag)) || R15_STORY.some((pattern) => pattern.test(story))) return 'R15';
  return 'All';
}

function framingConflicts(scene: unknown) {
  const keys = scenePositiveKeys(scene);
  const conflicts = [];
  const close = keys.has('close_up') || keys.has('face_focus');
  const medium = keys.has('medium_shot');
  const wide = keys.has('wide_shot') || keys.has('full_body') || keys.has('long_shot');
  if (close && medium) conflicts.push('close_up + medium_shot');
  if (close && wide) conflicts.push('close_up + wide/full_body');
  if (medium && keys.has('wide_shot')) conflicts.push('medium_shot + wide_shot');
  return conflicts;
}

function poseConflicts(scene: any) {
  const poseGroups = {
    standing: ['standing'],
    sitting: ['sitting', 'sitting_on_bed', 'sitting_on_chair', 'sitting_on_sofa', 'sitting_on_floor',
      'sitting_on_counter', 'sitting_on_desk', 'sitting_on_bench', 'sitting_on_lap'],
    lying: ['lying', 'lying_on_bed', 'lying_on_couch', 'lying_on_floor', 'lying_on_bench',
      'lying_on_table', 'lying_on_lap', 'lying_on_stomach'],
    kneeling: ['kneeling', 'all_fours']
  };
  const activeFor = (keys: Set<unknown>) => Object.entries(poseGroups)
    .filter(([, tags]) => tags.some((tag) => keys.has(tag)))
    .map(([name]) => name);
  if ((scene && scene.char === 'triad') || /\bBREAK\b/i.test(String(scene && scene.prompt || ''))) {
    const conflicts: string[] = [];
    splitPromptSegments(scene && scene.prompt).forEach((segment, index) => {
      const active = activeFor(new Set(segment.map(tokenKey)));
      if (active.length > 1) conflicts.push('segment ' + (index + 1) + ': ' + active.join(' + '));
    });
    return conflicts;
  }
  const active = activeFor(scenePositiveKeys(scene));
  return active.length > 1 ? [active.join(' + ')] : [];
}

function gazeConflicts(scene: any) {
  const conflicts = [];
  const segments = splitPromptSegments(scene && scene.prompt);
  for (let index = 0; index < segments.length; index += 1) {
    const keys = new Set(segments[index].map(tokenKey));
    if (keys.has('closed_eyes') && keys.has('looking_at_viewer')) {
      conflicts.push('segment ' + (index + 1) + ': closed_eyes + looking_at_viewer');
    }
  }
  return conflicts;
}

function adultSafetyIssues(scene: any) {
  if (!scene || scene.rating !== 'R18') return [];
  const issues = [];
  const positive = scenePositiveKeys(scene);
  const promptKeys = new Set(promptTokenKeys(scene.prompt));
  const negative = new Set(String(scene.negative || '').split(',').map(tokenKey).filter(Boolean));
  if (!promptKeys.has('adult') && ![...promptKeys].some(k => k.startsWith('adult_') || k.startsWith('adult-'))) issues.push('R18 positive prompt must include adult');
  for (const tag of ADULT_SAFETY_NEGATIVE) {
    if (!negative.has(tag)) issues.push('R18 negative prompt missing ' + tag);
  }
  for (const tag of YOUTH_UNIFORM_TAGS) {
    if (positive.has(tag)) issues.push('R18 positive prompt cannot include ' + tag);
  }
  return issues;
}

function auMetadataIssues(scene: any) {
  if (!scene) return [];
  const storyHasAu = /\bAU\b/i.test(String(scene.story || ''));
  const categoryHasAu = /AU|Active_Sync|\u540c\u4eba/i.test(String(scene.category || ''));
  const tags = new Set((scene.tags || []).map(tokenKey));
  const tagHasAu = [...tags].some((tag) => /_au$/.test(tag));
  const issues = [];
  if (storyHasAu && !categoryHasAu && !tagHasAu) issues.push('AU story needs AU category or *_au metadata tag');
  if (tagHasAu && !storyHasAu && !categoryHasAu) issues.push('AU metadata tag needs an AU story/category marker');
  return issues;
}

export = {
  ADULT_SAFETY_NEGATIVE,
  R15_TAGS,
  R18_TAGS,
  YOUTH_UNIFORM_TAGS,
  adultSafetyIssues,
  auMetadataIssues,
  framingConflicts,
  gazeConflicts,
  poseConflicts,
  promptTokenKeys,
  ratingFor,
  scenePositiveKeys,
  splitPromptSegments,
  tokenKey
};
