export type DesktopBuildProfile = 'release' | 'desktop-local';

export function desktopBuildProfile(value: unknown = 'release'): DesktopBuildProfile {
  if (value !== 'release' && value !== 'desktop-local') throw Error(`Unsupported desktop build profile: ${String(value)}`);
  return value;
}

export function desktopHostExecutable(profile: DesktopBuildProfile) {
  return `desktop-tauri/src-tauri/target/${profile}/ai-cg-studio-desktop.exe`;
}

export function desktopRuntimeExecutable(profile: DesktopBuildProfile) {
  return `runtime-rs/target/${profile}/huiyu-runtime${process.platform === 'win32' ? '.exe' : ''}`;
}

export function desktopRuntimeReceipt(profile: DesktopBuildProfile) {
  return `runtime/rust-evidence/${profile === 'release' ? 'build' : 'build-desktop-local'}.json`;
}
