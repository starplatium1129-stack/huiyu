'use strict';
function serviceError(status, code, message, detail) {
    var error = new Error(message);
    error.status = status;
    error.code = code;
    error.detail = detail;
    return error;
}
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
module.exports = {
    serviceError: serviceError,
    isPlainObject: isPlainObject,
    hasOwn: hasOwn,
};
