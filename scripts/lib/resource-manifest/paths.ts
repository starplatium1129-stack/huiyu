import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from '../runtime-errors';
import nodeFs = require('node:fs');
import path = require('node:path');

export const SCAN_ROOT = 'assets';
export const EXCLUDED_PATHS = Object.freeze(['assets/character-references', 'assets/live2d-candidates']);
const HEX_ESCAPE_RE = /%[0-9a-fA-F]{2}/;
const FORBIDDEN_CHARS_RE = /[\\:\u0000-\u001f\u007f]/;

export type ManifestOptions = { root: string; io?: typeof import('node:fs') };
type PathCheck = { ok: true } | { ok: false; code: string; message: string };

/** 参数/环境级失败；CLI 捕获后退出 2，区别于目标内容问题（退出 1）。 */
export class UsageError extends Error {}

export function isExcluded(rel: string) {
  const value = process.platform === 'win32' ? rel.toLowerCase() : rel;
  return EXCLUDED_PATHS.some((p) => value === p || value.startsWith(p + '/'));
}

export function isInsideRoot(rootReal: string, target: string) {
  const rel = path.relative(rootReal, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** 单字节字面解码：仅还原合法 %XX（含孤立 % 的文件名不受影响）；无变化返回 null。 */
function tryDecodePercent(text: string) {
  if (!text.includes('%')) return null;
  let out = '';
  let changed = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '%' && HEX_ESCAPE_RE.test(text.slice(i, i + 3))) {
      out += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
      changed = true;
    } else out += text[i];
  }
  return changed ? out : null;
}

/**
 * 清单路径合规检查（字面路径，非 URL）。返回 { ok: true } 或 { ok: false, code, message }。
 * 非法路径不得触发任何 fs 访问。
 */
export function checkManifestPath(rel: unknown): PathCheck {
  if (typeof rel !== 'string' || rel === '') return { ok: false, code: 'bad-entry', message: '路径必须是非空字符串' };
  if (FORBIDDEN_CHARS_RE.test(rel)) return { ok: false, code: 'illegal-path', message: '路径包含反斜杠、冒号或控制字符（Windows 分隔符/盘符/数据流形态不是资源路径）' };
  const normalized = path.posix.normalize(rel);
  if (normalized !== rel || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    return { ok: false, code: 'illegal-path', message: `路径必须使用归一化的 root 相对 posix 形式，收到: ${rel}` };
  }
  const segments = normalized.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return { ok: false, code: 'illegal-path', message: '路径含空段或点段' };
  }
  if (normalized === SCAN_ROOT || !normalized.startsWith(SCAN_ROOT + '/')) {
    return { ok: false, code: 'out-of-scope', message: `条目必须在 ${SCAN_ROOT}/ 下` };
  }
  if (isExcluded(normalized)) {
    return { ok: false, code: 'out-of-scope', message: `条目位于排除域 ${EXCLUDED_PATHS.join(', ')} 内` };
  }
  if (normalized.includes('%')) {
    const decoded = tryDecodePercent(normalized);
    if (decoded !== null) {
      if (FORBIDDEN_CHARS_RE.test(decoded)) return { ok: false, code: 'illegal-path', message: '百分号解码后出现分隔符/盘符/控制字符（编码越界被拒绝）' };
      if (decoded.split('/').length !== segments.length || decoded.split('/').some((s) => s === '' || s === '.' || s === '..')) {
        return { ok: false, code: 'illegal-path', message: '百分号解码改变路径段结构（编码分隔符或编码穿越被拒绝）' };
      }
    }
  }
  return { ok: true };
}

/**
 * 真实路径边界检查：解析 absPath 的真实位置，要求落在 rootReal 内。目标不存在时
 * 向上找最近存在祖先（覆盖悬空链接），不能以「目标不存在」跳过边界。只解析路径，
 * 不读取任何文件内容；junction/symlink 越界在 stat/读取之前被拒绝。
 */
export function resolveRealpathBoundary(io: typeof import("node:fs"), absPath: string, rootReal: string): { ok: true; realTarget: string } | { ok: false; code: string; message: string } {
  let cur = absPath;
  const missingTail = [];
  for (;;) {
    let real;
    try {
      real = io.realpathSync(cur);
    } catch (err) {
      if (runtimeErrorCode(err) === 'ENOENT') {
        const parent = path.dirname(cur);
        if (parent === cur) return { ok: false, code: 'realpath-error', message: '无法解析任何存在祖先的真实路径' };
        missingTail.unshift(path.basename(cur));
        cur = parent;
        continue;
      }
      return { ok: false, code: 'realpath-error', message: `realpath 失败: ${runtimeErrorCode(err) || runtimeErrorMessage(err)}` };
    }
    const realTarget = missingTail.length ? path.join(real, ...missingTail) : real;
    if (isInsideRoot(rootReal, realTarget)) return { ok: true, realTarget };
    return { ok: false, code: 'realpath-outside-root', message: `真实路径 ${realTarget} 落在 root 外（junction/symlink 越界），未做任何读取` };
  }
}

export function resolveRoot({ root, io = nodeFs }: ManifestOptions, label = 'root') {
  if (!root || typeof root !== 'string') throw new UsageError(`${label} 缺失或不是字符串`);
  let rootReal;
  try {
    rootReal = io.realpathSync(root);
  } catch (err) {
    throw new UsageError(`root 不可解析: ${runtimeErrorMessage(err)}`);
  }
  let st;
  try {
    st = io.statSync(rootReal);
  } catch (err) {
    throw new UsageError(`root 不可访问: ${runtimeErrorMessage(err)}`);
  }
  if (!st.isDirectory()) throw new UsageError('root 不是目录');
  return rootReal;
}
