'use strict';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { context, noLinks, readBytes, fail }: typeof import('./resource-install-fs') = require('./resource-install-fs');
const { releasePolicy }: typeof import('./resource-install-policy') = require('./resource-install-policy');
const { sourceUrl }: typeof import('./resource-download-http') = require('./resource-download-http');

// Operator-owned environment selects this file. Saved application settings and HTTP input
// cannot select roots, approve sources, grant management access, or replace callbacks.
function loadResourceConfiguration(gateway: any) {
  const file = gateway.RESOURCE_CONFIG_PATH;
  if (!file) return null;
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('CONFIG_REQUIRED', 'Resource configuration must be absolute');
  const bytes = readBytes(fs, file);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('CONFIG_REQUIRED', 'Invalid resource configuration'); }
  const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(value) || !object(value.policy) || !object(value.policy.sources)
    || !object(value.policy.releases) || !Array.isArray(value.protectedRoots)) {
    fail('CONFIG_REQUIRED', 'Explicit policy and protectedRoots are required');
  }
  const protectedRoots = [...value.protectedRoots, gateway.ROOT_DIR, gateway.ASSETS_ROOT,
    gateway.RUNTIME?.outputs, gateway.CHARACTER_REF_ROOT].filter(Boolean);
  for (const root of protectedRoots) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('CONFIG_REQUIRED', 'Protected roots must be absolute');
    const stat = noLinks(fs, root, { missing: true });
    if (stat && !stat.isDirectory()) fail('CONFIG_REQUIRED', 'Protected root is not a directory');
  }
  const unchanged = () => {
    try { return bytes.equals(readBytes(fs, file)); } catch { return false; }
  };
  const options = { userDataRoot: value.userDataRoot, protectedRoots, policy: value.policy,
    access: { isLocalStudioHost: () => true, isAuthorized: unchanged } };
  const ctx = context(options);
  const releases = [];
  for (const id of Object.keys(ctx.policy.releases)) {
    try {
      const release = releasePolicy(ctx, id);
      if (release.source.kind === 'http') sourceUrl(release, 'manifest.json');
      releases.push({ id, label: typeof release.label === 'string' ? release.label.slice(0, 100) : id,
        kind: release.kind, source: release.source.kind, identity: release.targetIdentity });
    } catch { /* Unapproved releases are not offered as actionable choices. */ }
  }
  return { file, bytes, options, ctx, releases, unchanged };
}

const MESSAGES: any = {
  CONFIG_REQUIRED: '尚未配置可信的本地资源库。',
  CONFIG_CHANGED: '资源配置已变化，请重新检查后操作。',
  PROTECTED_ROOT: '资源目录与程序或作品目录重叠，请调整本地配置。',
  ACCESS_DENIED: '本机授权已失效，操作已停止。',
  APPROVAL_REQUIRED: '该资源版本尚未获得独立审批。',
  SOURCE_REQUIRED: '资源来源未配置或未经批准。',
  UNSAFE_SOURCE: '资源来源不符合安全要求。',
  BUSY: '另一个资源操作正在执行，或中断操作需要恢复。',
  PENDING_TRANSACTION: '上次资源操作尚未完成，请恢复后再安装其他版本。',
  CANCELLED: '操作已取消，已验证资源与可续传内容已保留。',
  ENOSPC: '磁盘空间不足，原有资源仍被保留。',
  ENOENT: '资源文件缺失，请检查离线介质或先下载所选资源。',
  CONTENT_INVALID: '资源内容校验失败，正在使用随包基础资源。',
  INSTALLED_TAMPERED: '已安装资源被修改，已停止使用该资源版本。',
  BASELINE_MISMATCH: '增量包与当前安装版本不兼容。',
  NO_PREVIOUS_VERSION: '没有可回退的旧版本。',
  INTERRUPTED: '操作因网关重启中断，可继续恢复。',
  MANAGEMENT_DISABLED: '本机资源管理尚未启用，基础展示仍可使用。',
};
function publicError(error: any) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,50}$/.test(error.code) ? error.code : 'RESOURCE_FAILED';
  return { code, message: MESSAGES[code] || '资源操作未通过检查，请核对本地配置与资源包。' };
}
export = { loadResourceConfiguration, publicError };
