'use strict';


function normalizeMultimodalContent(parts: string|any[]) {
  if (!Array.isArray(parts) || !parts.length || parts.length > 8) {
    return { error:'多模态消息格式错误' };
  }
  let normalized = [];
  let imageCount = 0;
  for (let i = 0; i < parts.length; i += 1) {
    let part: any = parts[i] || {};
    if (part.type === 'text') {
      let text = String(part.text || '').trim();
      if (!text || text.length > 1200) return { error:'多模态文本过长' };
      normalized.push({ type:'text', text:text });
      continue;
    }
    if (part.type === 'image_url') {
      let url = String(part.image_url && part.image_url.url || '');
      // 只接受 data URL 图片（read_image 工具输出），防任意 URL 注入
      if (!/^data:image\/(?:png|jpeg|webp|gif);base64,/.test(url) || url.length > 12 * 1024 * 1024) {
        return { error:'图片消息只接受工作区图片的 data URL' };
      }
      // 2026-08-16 审计：单条消息图片数显式封顶（当前 read_image 视觉轮单图；防止
      // 多图把 14MB 传输预算占满的同时仍绕开文本裁剪语义）。
      imageCount += 1;
      if (imageCount > 4) return { error:'图片消息过多（单条最多 4 张）' };
      normalized.push({ type:'image_url', image_url:{ url:url } });
      continue;
    }
    return { error:'多模态消息包含未知内容类型' };
  }
  return { content:normalized };
}
export = { normalizeMultimodalContent };
