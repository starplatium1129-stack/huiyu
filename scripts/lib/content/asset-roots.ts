import fs from 'node:fs';
import path from 'node:path';

// Resolve configured external media for explicit maintenance tools. No gateway initialization.
function resolveSceneShowcaseDir(rootDir: string, configured?: any, workspaceRoot?: string) {
  // Accept either a published collection or its parent library folder.
  let roots = [];
  if (typeof configured === 'string' && configured.trim()) roots.push(path.resolve(configured));
  if (workspaceRoot) roots.push(path.join(workspaceRoot, 'SceneShowcase'));
  roots.push(path.resolve(rootDir, '..', 'AI', 'SceneShowcase'));
  for (const root of [...new Set(roots)]) {
    if (fs.existsSync(path.join(root, 'manifest.json'))) return root;
    try {
      let collections = fs.readdirSync(root, { withFileTypes:true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.')
          && fs.existsSync(path.join(root, entry.name, 'manifest.json')))
        .map(entry => path.join(root, entry.name))
        .sort((a, b) => path.basename(b).localeCompare(path.basename(a), 'zh-CN'));
      if (collections.length) return collections[0];
    } catch { /* A disconnected disk must not prevent the gateway from starting. */ }
  }
  return '';
}

function resolveCharRefRoot(appRoot: string, env: NodeJS.ProcessEnv, workspaceRoot?: string) {
  function isDirectory(candidate: string) {
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  }
  if (env.AICS_CHARACTER_REF_ROOT) {
    let explicit = path.resolve(env.AICS_CHARACTER_REF_ROOT);
    if (isDirectory(explicit)) return explicit;
    return ''; // 显式配置失效时不静默切换到另一份素材。
  }
  let bases = workspaceRoot
    ? [workspaceRoot, path.resolve(appRoot, '..', 'AI')]
    : [path.resolve(appRoot, '..', 'AI')];
  for (let i = 0; i < bases.length; i++) {
    let candidate = path.join(bases[i], 'CharacterReferences');
    if (isDirectory(candidate)) return candidate;
  }
  let legacy = path.join(path.resolve(env.AICS_ASSETS_ROOT || path.join(appRoot, 'assets')), 'character-references');
  if (isDirectory(legacy)) return legacy;
  return '';
}

export { resolveSceneShowcaseDir, resolveCharRefRoot };
