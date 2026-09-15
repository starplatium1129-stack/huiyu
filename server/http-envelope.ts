'use strict';

type JsonRecord = Record<string, any>;
type ErrorLike = { status?: number; statusCode?: number };
interface JsonResponse<Result> { json(body: any): Result }
interface FailureResponse<Result> { status(code: number): JsonResponse<Result> }
/**
 * server/http-envelope.js — API 响应信封的唯一定义。
 *
 * 修的是审计 B-6：全站曾有四种错误形状同时存在 ——
 *   { error }                    （chat / voice / maintenance 大部分）
 *   { ok:false, msg }            （/api/start、/api/stop）
 *   { ok:false, error }          （/api/service/*、/api/mode）
 *   { error, detail }            （chat 流失败、tts 失败）
 * 于是前端到处写 `data.error || data.msg || '操作失败'` 这种防御式取值，
 * 少写一个候选就变成"操作失败"这类无信息文案。
 *
 * 现在统一为：
 *   成功 { ok:true,  ...payload }
 *   失败 { ok:false, error:'人能读的原因', detail?:'技术细节', code?:'机器可判别' }
 *
 * `msg` 作为 `error` 的镜像保留在失败信封里 —— 只为兼容可能还在用旧字段的
 * 分享链接页面缓存；新代码不要读它。前端已全部改读 `error`。
 */

function fail<Result>(res: FailureResponse<Result>, status: number, error: any, extra?: JsonRecord): Result {
  let body: JsonRecord = Object.assign({ ok:false, error:String(error || '请求无法处理') }, extra || {});
  // 旧字段镜像，见文件头注释
  body.msg = body.error;
  return res.status(status).json(body);
}

function ok<Result>(res: JsonResponse<Result>, payload?: JsonRecord): Result {
  return res.json(Object.assign({ ok:true }, payload || {}));
}

/**
 * 从上游/内部错误里挑一个合适的 HTTP 状态。
 * 4xx 原样透传（那是客户端的问题），其余归到 fallback。
 */
function statusFor(error: any, fallback?: number) {
  let detail = error as ErrorLike | null | undefined;
  let status = Number(detail && (detail.status || detail.statusCode));
  if (Number.isInteger(status) && status >= 400 && status < 500) return status;
  return fallback || 500;
}

export = { ok:ok, fail:fail, statusFor:statusFor };
