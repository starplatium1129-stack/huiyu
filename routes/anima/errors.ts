'use strict';

/**
 * routes/anima/errors.js —— serviceError 工厂与基础守卫（同 routes/video/errors 形状）。
 */


interface ServiceError extends Error { status: number; code: string; detail?: unknown }

function serviceError(status: number, code: string, message?: string, detail?: unknown): ServiceError {
  let error = new Error(message) as ServiceError;
  error.status = status;
  error.code = code;
  error.detail = detail;
  return error;
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function hasOwn<Value extends object>(value: Value, key: PropertyKey): key is keyof Value {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export = {
  serviceError:serviceError,
  isPlainObject:isPlainObject,
  hasOwn:hasOwn,
};
