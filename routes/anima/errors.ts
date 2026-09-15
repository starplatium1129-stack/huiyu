'use strict';

/**
 * routes/anima/errors.js —— serviceError 工厂与基础守卫（同 routes/video/errors 形状）。
 */


interface ServiceError extends Error { status: number; code: string; detail?: any }

function serviceError(status: number, code: string, message?: string, detail?: any): ServiceError {
  let error = new Error(message) as ServiceError;
  error.status = status;
  error.code = code;
  error.detail = detail;
  return error;
}
function isPlainObject(value: any): value is Record<string, any> {
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
