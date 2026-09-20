export function error(status: number, code: string | number, message: string | undefined, detail?: unknown) {
    return Object.assign(new Error(message), { status, code, detail });
}
export function plain(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function number(v: unknown, name: string, min: number, max: number, integer: boolean) {
    if (typeof v !== 'number' || !Number.isFinite(v) || (integer && !Number.isInteger(v)) || v < min || v > max) {
        throw error(400, 'INVALID_PARAMETER', name + ' 超出允许范围');
    }
    return v;
}
