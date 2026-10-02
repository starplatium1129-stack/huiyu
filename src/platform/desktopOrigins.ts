/** Exact bundled application origins; a hostname substring never grants access. */
export const ELECTRON_UI_ORIGIN = 'https://huiyu.localhost';
export const NATIVE_DESKTOP_ORIGINS: readonly string[] = Object.freeze([
  'http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost', ELECTRON_UI_ORIGIN,
]);
export function isNativeDesktopOrigin(origin: unknown): origin is string {
  return NATIVE_DESKTOP_ORIGINS.includes(origin as string);
}
