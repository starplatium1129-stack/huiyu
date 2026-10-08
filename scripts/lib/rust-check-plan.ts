export type NativeRustTarget = 'host' | 'renderer'
export const NATIVE_MANIFESTS: Record<NativeRustTarget, string> = {
  host: 'desktop-tauri/src-tauri/Cargo.toml',
  renderer: 'desktop-tauri/native-live2d/Cargo.toml',
}

// Only independent read paths with existing behavioral coverage are narrowed.
// Shared storage/write/schema/service changes retain the complete runtime lane.
const READ_TESTS: Record<string, readonly string[]> = {
  'runtime-rs/src/storage/recent.rs': ['--test', 'storage_preferences'],
  'runtime-rs/tests/storage_preferences.rs': ['--test', 'storage_preferences'],
  'runtime-rs/src/catalog/query.rs': ['--lib', 'catalog::tests::'],
  'runtime-rs/src/catalog/facet_cache.rs': ['--lib', 'catalog::tests::'],
  'runtime-rs/src/catalog/tests/query.rs': ['--lib', 'catalog::tests::'],
  'runtime-rs/src/catalog/tests/facet_cache.rs': ['--lib', 'catalog::tests::'],
}
export function runtimeTestSelection(files: readonly string[]): ReadonlyArray<readonly string[]> | undefined {
  if (!files.length || files.some(file => !READ_TESTS[file])) return undefined
  return [...new Map(files.map(file => {
    const args = READ_TESTS[file]
    return [JSON.stringify(args), [...args]] as const
  })).values()]
}
export function nativeTargetForFile(file: string): NativeRustTarget | undefined {
  if (!/\.(?:rs|wgsl|cpp|h|toml|lock)$/.test(file)) return undefined
  if (file.startsWith('desktop-tauri/native-live2d/')) return 'renderer'
  if (file.startsWith('desktop-tauri/src-tauri/')) return 'host'
  return undefined
}
