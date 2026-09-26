'use strict';
const COMMANDS = new Set(['set_character', 'get_state', 'set_frame', 'set_max_fps', 'play_motion',
  'set_expression', 'set_mouth_level', 'set_emotion', 'set_gaze', 'hit_test', 'destroy'].map(name => 'aics_live2d_' + name));
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unexpected Live2D parameters');
}
function number(value, name, min, max, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) throw new Error('Invalid ' + name);
  return value;
}
function text(value, name, max = 160) {
  if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value)) throw new Error('Invalid ' + name);
  return value;
}
function translate(command, args = {}, getCompanionHwnd) {
  if (!COMMANDS.has(command)) throw new Error('Live2D command denied');
  switch (command) {
    case 'aics_live2d_set_character': {
      fields(args, ['modelPath', 'character', 'textureScale', 'adapter']);
      const character = args.character || 'nene';
      if (!['nene', 'natsume'].includes(character)) throw new Error('R13 only loads the two approved builtin models');
      // As in Tauri, this is a browser resource URL (including live2d-current
      // aliases), never a native filesystem path. Native resolves only the
      // approved character/profile beneath the host-supplied assets root.
      if (args.modelPath != null) text(args.modelPath, 'modelPath', 1024);
      const scale = args.textureScale ?? 1;
      if (![1, 2, 4].includes(scale)) throw new Error('Invalid texture scale');
      if (!args.adapter || args.adapter.profileId !== `profile-${character}-v1`) throw new Error('Builtin adapter identity mismatch');
      // Runtime adapter DTO only. Profile/UI metadata and arbitrary fields never
      // cross into the native command, whose parameter mappings validate again.
      const adapter = Object.fromEntries(['profileId', 'mouth', 'blink', 'focus', 'emotionParams', 'overlaySettle', 'entranceGroup', 'leaveGroup']
        .filter(key => args.adapter[key] !== undefined).map(key => [key, args.adapter[key]]));
      return { type: 'setCharacter', character, texture_scale: scale, adapter };
    }
    case 'aics_live2d_set_frame': {
      fields(args, ['rect', 'visible', 'opacity', 'framing']); fields(args.rect, ['x', 'y', 'width', 'height']);
      if (typeof args.visible !== 'boolean') throw new Error('Invalid visibility');
      const rect = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key,
        number(args.rect[key], 'rect.' + key, key === 'x' || key === 'y' ? -32768 : 0, 32768, true)]));
      let framing = null;
      if (args.framing != null) {
        fields(args.framing, ['zoom', 'x', 'y']);
        framing = { zoom: number(args.framing.zoom, 'zoom', 0.65, 2.2),
          x: number(args.framing.x, 'framing.x', -0.25, 0.25), y: number(args.framing.y, 'framing.y', -0.25, 0.25) };
      }
      const handle = getCompanionHwnd();
      const hwnd = Buffer.isBuffer(handle) ? Number(handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE()) : handle;
      if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error('Companion window unavailable');
      return { type: 'setFrame', rect, visible: args.visible, framing, companion_hwnd: hwnd,
        opacity: args.opacity == null ? null : Math.round(number(args.opacity, 'opacity', 0, 1) * 255) };
    }
    case 'aics_live2d_play_motion':
      fields(args, ['group', 'index', 'priority']);
      if (args.priority != null && !['idle', 'normal', 'force'].includes(args.priority)) throw new Error('Invalid motion priority');
      return { type: 'playMotion', group: text(args.group, 'group'),
        index: args.index == null ? null : number(args.index, 'index', 0, 10000, true), priority: args.priority ?? null };
    case 'aics_live2d_set_expression': fields(args, ['name']); return { type: 'setExpression', name: text(args.name, 'expression') };
    case 'aics_live2d_set_mouth_level': fields(args, ['level']); return { type: 'setMouthLevel', level: number(args.level, 'mouth level', 0, 1) };
    case 'aics_live2d_set_emotion': fields(args, ['name', 'intensity']);
      return { type: 'setEmotion', name: text(args.name, 'emotion', 80), intensity: number(args.intensity, 'intensity', 0, 1) };
    case 'aics_live2d_set_max_fps': fields(args, ['fps']); return { type: 'setMaxFps', fps: Math.round(number(args.fps, 'fps', 1, 1000)) };
    case 'aics_live2d_set_gaze': case 'aics_live2d_hit_test': fields(args, ['x', 'y']);
      return { type: command.endsWith('hit_test') ? 'hitTest' : 'setGaze', x: number(args.x, 'x', -1, 1), y: number(args.y, 'y', -1, 1) };
    case 'aics_live2d_get_state': fields(args, []); return { type: 'getState' };
    case 'aics_live2d_destroy': fields(args, []); return { type: 'destroy' };
  }
}
function inactive() {
  return { active: false, rect: { x: 0, y: 0, width: 0, height: 0 }, visible: false, frameCount: 0,
    targetFps: 0, character: null, ready: false, windowReady: false, rendererAttached: false,
    starting: false, modelBounds: null, mouthLevel: 0, mouthMappedValue: 0, surfaceFailures: 0,
    surfaceRecoveries: 0, renderErrors: 0 };
}
module.exports = { COMMANDS, translate, inactive };
