'use strict';
type AdultBody = { character?: unknown; prompt?: unknown; loras?: any };
type LoraOptions = { useLoras?: boolean };


/**
 * server/validation-core.js —— 成人内容 fail-closed 门控的单一实现（2026-08-28
 * 工程审计 P1-6）。此前 assertAdultAllowed 在 routes/anima/validation.js、
 * routes/video/validation.js、routes/generation.js、routes/desktop-tools.js
 * 有 4 份签名互异的实现——R18 门控是最不该漂移的逻辑，下一次规则变更会有
 * 3 处漏改风险。本模块收敛常量与纯判定（不抛错、不依赖请求对象）；各路由
 * 保留自己的错误形态（serviceError / error / 返回值）与请求上下文装配
 * （req / isLocal / context）。
 *
 * 契约（AGENTS.md 红线 #4，scripts/tests/test-security.js 锁定）：
 * - 白名单：ADULT_ELIGIBLE_CHARACTERS 之外的角色一律拒绝（unknown fail-closed）；
 * - 授权：adultEnabled 必须显式 === true，请求体自报不单独构成远程授权；
 * - 远程/隧道默认拒绝，AICS_ADULT_REMOTE=1 显式开启后按原双门放行。
 */

let security: typeof import('./security') = require('./security');

let ADULT_ELIGIBLE_CHARACTERS = Object.freeze(new Set(['nene', 'natsume']));

// 成人锚点正则：与内容契约的 nene_r18 / natsume_r18 门控词同源。
// 服务端二次门控用（明言避免前端绕过），四个家族共用同一份。
let ADULT_PROMPT_RE = /\b(?:nude|naked|completely_naked|explicit|nsfw|nene_r18|natsume_r18|exposed_pussy|pink_nipples)\b/i;

let ADULT_NOT_ELIGIBLE_MESSAGE = '该角色未登记为成人内容白名单（fail-closed），已拒绝 R18 参数；请用普通服装重试。';
let ADULT_NOT_ENABLED_MESSAGE = '成人内容未获本机授权（adultEnabled !== true），已拒绝 R18 参数；请用普通服装重试。';
let ADULT_REMOTE_NOT_ALLOWED_MESSAGE = '成人内容仅限本机直连使用；如需经分享隧道使用，请在服务端设置 AICS_ADULT_REMOTE=1 后重启网关。';

/** 提示词是否命中成人锚点（词边界语义；"xnsfw" 这类粘连词不误报）。 */
function detectAdultIntent(prompt: unknown): boolean {
  return ADULT_PROMPT_RE.test(String(prompt || ''));
}

/**
 * 成人目标角色推断（白名单匹配前的归一化输入）。
 * 优先级：显式 character 字段 → LoRA ID（v18 双家族）→ prompt r18 锚点。
 * @param {object} body 请求体
 * @param {{useLoras?: boolean}} [options] anima 家族此前的语义不含 LoRA 推断
 *   （带 LoRA 无锚点时白名单拒绝），useLoras:false 保持其原行为不漂移。
 * @returns {string} 归一化角色 ID，推断不出时为空串
 */
function inferAdultTargetChar(body: AdultBody | null | undefined, options?: LoraOptions): string {
  let input = body || {};
  let explicit = String(input.character || '').toLowerCase();
  if (explicit) return explicit;
  let prompt = String(input.prompt || '');
  if (options && options.useLoras && Array.isArray(input.loras)) {
    let hasNene = input.loras.some(function (l) { return String((l && l.id) || '').toUpperCase() === 'L_NENE_V18_WD14'; });
    let hasNatsume = input.loras.some(function (l) { return String((l && l.id) || '').toUpperCase() === 'L_NAT_V18_WD14'; });
    if (hasNene) return 'nene';
    if (hasNatsume) return 'natsume';
  }
  if (/nene_r18/i.test(prompt)) return 'nene';
  if (/natsume_r18/i.test(prompt)) return 'natsume';
  return '';
}

/**
 * 双门纯判定：角色白名单 + adultEnabled 传输层授权。
 * @returns {null | {reason: 'CHARACTER_NOT_ELIGIBLE'|'NOT_ENABLED', message: string}}
 *   null = 放行。desktop-tools 等返回值形态的调用方按 reason 映射自己的 code。
 */
function evaluateAdultAccess(targetChar: unknown, adultEnabled: unknown) {
  if (!ADULT_ELIGIBLE_CHARACTERS.has(String(targetChar || '').toLowerCase())) {
    return { reason: 'CHARACTER_NOT_ELIGIBLE', message: ADULT_NOT_ELIGIBLE_MESSAGE };
  }
  if (adultEnabled !== true) {
    return { reason: 'NOT_ENABLED', message: ADULT_NOT_ENABLED_MESSAGE };
  }
  return null;
}

/**
 * 远程门：isLocal 缺省/true 视为本机放行（内部重放路径不持 req）；
 * 远程/隧道默认拒绝，AICS_ADULT_REMOTE=1 后放行。
 * @returns {null | {code: 'ADULT_REMOTE_NOT_ALLOWED', message: string}}
 */
function evaluateAdultRemote(isLocal: unknown) {
  if (isLocal !== false) return null;
  if (security.adultRemoteEnabled()) return null;
  return { code: 'ADULT_REMOTE_NOT_ALLOWED', message: ADULT_REMOTE_NOT_ALLOWED_MESSAGE };
}

export = {
  ADULT_ELIGIBLE_CHARACTERS: ADULT_ELIGIBLE_CHARACTERS,
  ADULT_PROMPT_RE: ADULT_PROMPT_RE,
  ADULT_NOT_ELIGIBLE_MESSAGE: ADULT_NOT_ELIGIBLE_MESSAGE,
  ADULT_NOT_ENABLED_MESSAGE: ADULT_NOT_ENABLED_MESSAGE,
  ADULT_REMOTE_NOT_ALLOWED_MESSAGE: ADULT_REMOTE_NOT_ALLOWED_MESSAGE,
  detectAdultIntent: detectAdultIntent,
  inferAdultTargetChar: inferAdultTargetChar,
  evaluateAdultAccess: evaluateAdultAccess,
  evaluateAdultRemote: evaluateAdultRemote,
};
