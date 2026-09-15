'use strict';
const { assembleNegative, sceneTemplateText }: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
const { sceneShot }: typeof import('../../src/utils/sceneInference.ts') = require('../../src/utils/sceneInference.ts');

/** 与工作台相同的默认镜头、模板过滤和负向组装。检索 tags 不自动发送给模型。 */
function renderedScene(scene: any) {
  const shot = sceneShot(scene);
  return {
    ...scene,
    tags: [],
    prompt: sceneTemplateText(scene, { char: scene.char, shot, engine: 'anima' }),
    negative: assembleNegative(null, scene, 'anima', { character: scene.char, shot }),
  };
}
export = { renderedScene };
