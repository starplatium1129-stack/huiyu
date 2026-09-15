'use strict';

// SceneShowcase 静态文件白名单。
//
// 规则分两层：
//  1) 先按字面拒掉一切「不是普通相对路径」的输入：绝对 URL（// 或 scheme://）、
//     反斜杠、dot-dot 穿越、URL 编码（%2e 等）、query/hash 片段。这样即使未来
//     某个前缀被放宽，穿越/编码/绝对地址也仍然进不了 express.static。
//  2) 再按白名单正则精确匹配。images|thumbs 只放行 scNNN 场景文件与受约束前缀
//     artist_ / pc_ / lora_ 的 jpg/png/webp —— 新发布条目（画师/热门角色/LoRA）
//     的资产都落在这些前缀下。
//
// 白名单之外的一律 404，绝不回退到 SPA 外壳。

let SHOWCASE_FILE = /^\/(?:manifest\.json|00-cover\.jpg|README\.txt|home\/(?:nene|natsume)\.jpg|images\/(?:sc\d{3}|artist_[a-z0-9_-]+|pc_[a-z0-9_-]+|lora_[a-z0-9_-]+)\.(?:jpg|png|webp)|thumbs\/(?:sc\d{3}|artist_[a-z0-9_-]+|pc_[a-z0-9_-]+|lora_[a-z0-9_-]+)\.(?:jpg|png|webp)|sheets\/[a-z0-9_-]+\/[a-z0-9_.-]+\.jpg)$/i;

function isShowcaseAssetPath(requestPath: string|string[]) {
  if (typeof requestPath !== 'string' || requestPath.length < 2 || requestPath[0] !== '/') return false;
  // 反斜杠 / URL 编码 / query / hash —— Express req.path 已剥 query/hash，
  // 但纯函数要能独立拒绝携带这些字符的输入。
  if (/[\\%?#]/.test(requestPath)) return false;
  // dot-dot 穿越（含未解码形式）。
  if (requestPath.indexOf('..') !== -1) return false;
  // 绝对 URL：协议相对 //host 与 scheme://host。
  if (/^\/\//.test(requestPath)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(requestPath)) return false;
  return SHOWCASE_FILE.test(requestPath);
}

export = {
  isShowcaseAssetPath: isShowcaseAssetPath
};
