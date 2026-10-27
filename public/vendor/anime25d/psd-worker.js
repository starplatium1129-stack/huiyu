/* Adapted from 852wa/Anime2.5DRig@7ddbd9943ea3152561b3dc8348fd752c850f3e95, MIT. */
'use strict';
importScripts('ag-psd.min.js', 'rigger.js', 'runtime.js', 'genericparts.js');
agPsd.initializeCanvas(undefined, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
onmessage = function ({ data: { buffer } }) {
  try {
    RigRuntime.validateHeader(buffer);
    postMessage({ progress: '检查图层结构…' });
    const options = { useImageData: true, skipThumbnail: true, skipCompositeImageData: true };
    Rigger.validatePsd(agPsd.readPsd(new Uint8Array(buffer), { ...options, skipLayerImageData: true }));
    postMessage({ progress: '解析图层并自动绑定…' });
    const psd = agPsd.readPsd(new Uint8Array(buffer), options);
    // Current See-through exports already-split parts as "eyewhite-l" etc.
    // The pinned rigger accepts numbered semantic parts and assigns sides by
    // their pixels. Preserve each image/order and let it recover the side.
    function normalizeSides(layers) {
      for (const layer of layers || []) {
        if (layer.children) normalizeSides(layer.children);
        const match = /^(.*)[_-]([lr])$/i.exec(layer.name || '');
        if (!match) continue;
        const base = Rigger.normName(match[1]);
        if (Rigger.SLOT_NAMES.includes(base)) layer.name = base + (match[2].toLowerCase() === 'l' ? '_1' : '_2');
      }
    }
    normalizeSides(psd.children);
    Rigger.cleanPsdLayers(psd);
    const generic = Object.fromEntries(['eyeL', 'eyeR', 'mouth'].map(key => [key, GenericParts.get(key)]));
    const rig = Rigger.buildRig(psd, { generic });
    rig.warnings = rig.warnings.map(warning => {
      if (warning.startsWith('不足する閉じ目')) return '缺少闭眼差分，已自动补充通用闭眼图层；专门绘制的差分可改善效果。';
      if (warning.startsWith('mouth_close が無い')) return '缺少闭口差分，已自动补充通用闭口图层；专门绘制的差分可改善效果。';
      return warning;
    });
    if (!rig.layers.some(layer => Rigger.baseName(layer.name) === 'face')
      || rig.layers.filter(layer => !layer.synthetic).length < 2) {
      throw new Error('请导入包含 face 和其他独立角色部件的分层 PSD，合并后的单层图片无法绑定');
    }
    const transfers = rig.layers.map(layer => layer.img.data.buffer);
    postMessage({ rig }, [...new Set(transfers)]);
  } catch (error) { postMessage({ error: error.message || String(error) }); }
};
