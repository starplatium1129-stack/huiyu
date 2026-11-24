import { readFileSync, statSync } from 'node:fs';
import { posix, resolve } from 'node:path';

type Row = Record<string, unknown>;
const root = resolve(__dirname, '../..');
const catalogFile = 'runtime-rs/src/images/catalog.json';
const overlayFile = 'runtime-rs/src/images/endfield-lora.json';
const setupFile = 'runtime-rs/src/control/setup-models.json';
const adapterFile = 'tools/inference/adapter-models.json';
const managedFile = 'tools/inference/managed-models.json';
const managedAdapterFile = 'tools/inference/managed-adapter-models.json';
const auxiliaryFile = 'tools/inference/managed-auxiliary-models.json';
const mirrorsFile = 'tools/inference/managed-model-mirrors.json';
const sha256 = /^[0-9a-f]{64}$/;
const gitSha = /^[0-9a-f]{40}$/;
const separateRunner = new Set(['sd-cpp', 'wan-a14b-sd', 'musetalk-native']);

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}
function hasDigest(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}
function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function setupUrl(file: Row): unknown {
  if (file.sourceUrl != null) return file.sourceUrl;
  const { repo, revision, remotePath } = file;
  if (isId(repo) && isId(revision) && isId(remotePath)) {
    return 'https://huggingface.co/' + repo + '/resolve/' + revision + '/' + remotePath;
  }
}
function artifactIdentity(url: unknown, file: Row): string | undefined {
  if (isId(url) && isByteCount(file.bytes) && hasDigest(file.sha256, sha256)) {
    return JSON.stringify([url, file.bytes, file.sha256]);
  }
}

function check(): void {
  const errors: string[] = [];
  const manifests = new Map<string, Row>();
  const primaryArtifacts = new Set<string>();
  const gitPinned = new Set<Row>();
  let gitLfs = 0;
  function fail(at: string, reason: string): void {
    errors.push(at + ' — ' + reason);
  }
  function map(value: unknown, at: string): Row {
    if (isRow(value)) return value;
    fail(at, '应为 JSON 对象');
    return {};
  }
  function array(value: unknown, at: string): unknown[] {
    if (Array.isArray(value)) return value;
    fail(at, '应为 JSON 数组');
    return [];
  }
  function rows(value: unknown, at: string): Row[] {
    return array(value, at).map((entry, i) => map(entry, at + '[' + i + ']'));
  }
  function listById(value: unknown, at: string): Map<string, Row> {
    const byId = new Map<string, Row>();
    for (const row of rows(value, at)) {
      if (!isId(row.id)) fail(at, '缺少有效 ID');
      else if (byId.has(row.id)) fail(at, '重复 ID ' + row.id);
      else byId.set(row.id, row);
    }
    return byId;
  }
  function keyedById(value: unknown, at: string): Map<string, Row> {
    const byId = new Map<string, Row>();
    for (const [id, entry] of Object.entries(map(value, at))) {
      if (!isId(id)) fail(at, '无效 ID ' + JSON.stringify(id));
      byId.set(id, map(entry, at + '.' + id));
    }
    return byId;
  }
  function readScriptSource(file: string): string {
    try {
      return readFileSync(resolve(root, file), 'utf8');
    } catch (err) {
      fail(file, err instanceof Error ? err.message : String(err));
      return '';
    }
  }
  function readManifest(file: string): Row {
    try {
      const source = readFileSync(resolve(root, file), 'utf8');
      const parsed: unknown = JSON.parse(source);
      // JSON.parse accepts duplicate keys. Inspect decoded key tokens after syntax validation.
      const objects: (Set<string> | null)[] = [];
      for (const match of source.matchAll(/("(?:[^"\\]|\\.)*")(\s*:)?|[{}\[\]]/gs)) {
        const token = match[0];
        if (token === '{') objects.push(new Set());
        else if (token === '[') objects.push(null);
        else if (token === '}' || token === ']') objects.pop();
        else if (match[2]) {
          const key = JSON.parse(match[1]) as string;
          const keys = objects.at(-1);
          if (keys?.has(key)) {
            const line = source.slice(0, match.index).split('\n').length;
            fail(file + ':' + line, '重复 JSON 键 ' + JSON.stringify(key));
          }
          keys?.add(key);
        }
      }
      const manifest = map(parsed, file);
      manifests.set(file, manifest);
      return manifest;
    } catch (err) {
      if (file !== mirrorsFile || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        fail(file, err instanceof Error ? err.message : String(err));
      }
      return {};
    }
  }
  function checkFields(value: unknown, at: string, isPrimary: boolean): void {
    if (Array.isArray(value)) {
      value.forEach((entry, i) => checkFields(entry, at + '[' + i + ']', isPrimary));
      return;
    }
    if (!isRow(value)) return;
    if (isPrimary) {
      const identity = artifactIdentity(value.url ?? value.downloadUrl ?? setupUrl(value), value);
      if (identity) primaryArtifacts.add(identity);
    }
    for (const [key, entry] of Object.entries(value)) {
      const field = at + '.' + key;
      if (key === 'id' && !isId(entry)) fail(field, 'ID 为空或含首尾空白');
      if (['bytes', 'size', 'requiredBytes'].includes(key) && !isByteCount(entry)) {
        fail(field, '应为正整数');
      }
      if (/sha256$/i.test(key)) {
        const digests = key === 'previousArchiveSha256' ? array(entry, field) : [entry];
        if (digests.some(digest => !hasDigest(digest, sha256)) &&
            !(key === 'sha256' && entry === '' && gitPinned.has(value))) {
          fail(field, '应为 64 位小写十六进制 SHA-256');
        }
      }
      if (key === 'gitBlobId' && !hasDigest(entry, gitSha)) {
        fail(field, '应为 40 位小写十六进制 Git 对象 ID');
      }
      checkFields(entry, field, isPrimary);
    }
  }
  function checkArtifacts(bundle: Row, at: string, acceptGitPins = false): Set<string> {
    const paths = new Set<string>();
    for (const [i, file] of rows(bundle.files, at + '.files').entries()) {
      const field = at + '.files[' + i + ']';
      if (!isId(file.path)) fail(field, '缺少有效文件路径');
      else if (paths.has(file.path)) fail(field, '重复文件路径 ' + file.path);
      else paths.add(file.path);
      if (!isByteCount(file.bytes)) fail(field, '缺少有效文件字节数');
      if (!Object.hasOwn(file, 'sha256')) fail(field, '缺少 sha256 字段');
      if (acceptGitPins && file.sha256 === '') {
        // The Rust resolver accepts pinned Git blobs, including gated Git LFS pointers.
        const repo = bundle.sourceUrl;
        const revision = bundle.revision;
        const prefix = String(repo) + '/resolve/' + String(revision) + '/';
        if (hasDigest(file.gitBlobId, gitSha) && typeof file.lfs === 'boolean' &&
            hasDigest(revision, gitSha) && typeof repo === 'string' &&
            /^https:\/\/huggingface\.co\/[^/?#\s]+\/[^/?#\s]+$/.test(repo) &&
            isId(file.url) && file.url.startsWith(prefix) && file.url.length > prefix.length) {
          gitPinned.add(file);
          if (file.lfs) gitLfs += 1;
        } else {
          fail(field, '空 SHA-256 需要有效的 Git 对象 ID、lfs 标记和固定提交的 Hugging Face 下载地址');
        }
      }
    }
    return paths;
  }

  const catalog = readManifest(catalogFile);
  const overlay = readManifest(overlayFile);
  const setup = readManifest(setupFile);
  const adapter = readManifest(adapterFile);
  const managed = readManifest(managedFile);
  const managedAdapter = readManifest(managedAdapterFile);
  const auxiliary = readManifest(auxiliaryFile);
  const mirrors = readManifest(mirrorsFile);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
    return;
  }

  const models = keyedById(catalog.MODELS, catalogFile + '.MODELS');
  const profiles = map(catalog.PROFILE_BY_MODEL, catalogFile + '.PROFILE_BY_MODEL');
  const loras = keyedById(catalog.LORAS, catalogFile + '.LORAS');
  keyedById(catalog.KREA_STYLE_LORAS, catalogFile + '.KREA_STYLE_LORAS');
  keyedById(catalog.CHARACTERS, catalogFile + '.CHARACTERS');
  const setupModels = listById(setup.files, setupFile + '.files');
  const managedModels = listById(managed.models, managedFile + '.models');
  const adapters = keyedById(adapter.models, adapterFile + '.models');
  const adapterBundles = listById(managedAdapter.models, managedAdapterFile + '.models');
  const auxiliaryBundles = listById(auxiliary.resources, auxiliaryFile + '.resources');
  const layouts = keyedById(adapter.layouts, adapterFile + '.layouts');
  for (const id of Object.keys(map(adapter.pendingVideo, adapterFile + '.pendingVideo'))) {
    if (!isId(id)) fail(adapterFile + '.pendingVideo', '无效模型 ID ' + JSON.stringify(id));
  }
  const keyframeAssets = keyedById(adapter.keyframeAssets, adapterFile + '.keyframeAssets');

  const nativeIds = new Set<string>();
  const addNative = (id: string, at: string): void => {
    if (nativeIds.has(id)) fail(at, '重复的原生模型 ID ' + id);
    nativeIds.add(id);
  };

  const conversionSource = readScriptSource('tools/inference/anima_conversion_profile.py');
  const conversionProfiles = new Set(
    [...conversionSource.matchAll(/^\w*PROFILE\s*=\s*"([^"]+)"\s*$/gm)].map(match => match[1]),
  );
  let usesAnimaConversion = false;
  for (const [id, file] of setupModels) {
    const at = setupFile + '.files.' + id;
    if (!isId(file.path) || !isByteCount(file.bytes) || !hasDigest(file.sha256, sha256)) {
      fail(at, '安装文件需要路径、字节数和 SHA-256');
    }
    if (file.kind === 'lora' && id !== overlay.id) {
      const lora = loras.get(id);
      if (!lora || posix.basename(String(file.path)) !== lora.file) {
        fail(at, '图像目录缺少同 ID 和文件名的 LoRA');
      }
    }
    if (id.startsWith('anima-') || Object.hasOwn(file, 'nativeConversionProfile')) {
      if (file.kind !== 'image' || models.get(id)?.family !== 'anima') {
        fail(at, '图像目录没有对应的 Anima 模型');
      }
      if (Object.hasOwn(file, 'nativeConversionProfile')) {
        if (isId(file.nativeConversionProfile) && conversionProfiles.has(file.nativeConversionProfile)) {
          usesAnimaConversion = true;
          addNative(id, at);
        } else {
          fail(at, '未知 Anima 转换配置 ' + String(file.nativeConversionProfile));
        }
      }
    }
  }
  if (isId(overlay.id)) {
    const file = setupModels.get(overlay.id);
    if (loras.has(overlay.id)) fail(overlayFile, 'LoRA ID 已在图像目录中声明');
    if (!file || file.kind !== 'lora' || posix.basename(String(file.path)) !== overlay.file ||
        file.bytes !== overlay.bytes || file.sha256 !== overlay.sha256 || setupUrl(file) !== overlay.downloadUrl) {
      fail(overlayFile, '在安装清单中找不到匹配的 LoRA 文件和校验信息');
    }
  } else {
    fail(overlayFile, '缺少有效 LoRA ID');
  }
  for (const [id, model] of models) {
    const at = catalogFile + '.MODELS.' + id;
    if (!isId(model.profileId) || !Object.hasOwn(profiles, id) || model.profileId !== profiles[id]) {
      fail(at, '与 PROFILE_BY_MODEL 声明不一致');
    }
    // ComfyUI-only entries are served by the legacy download tooling.
    if (model.family !== 'anima') continue;
    const setupModel = setupModels.get(id);
    if (!setupModel && !managedModels.has(id)) fail(at, '安装和托管清单都缺少该模型');
    if (setupModel && posix.basename(String(setupModel.path)) !== model.file) {
      fail(at, '安装清单中的文件名与目录不一致');
    }
    if (setupModel && !Object.hasOwn(setupModel, 'nativeConversionProfile') && !managedModels.has(id)) {
      fail(at, '缺少原生转换配置或托管模型');
    }
  }
  for (const id of Object.keys(profiles)) {
    if (!models.has(id)) fail(catalogFile + '.PROFILE_BY_MODEL', '未知模型 ID ' + id);
  }
  if (!isId(setup.recommendedModel) || models.get(setup.recommendedModel)?.family !== 'anima' ||
      !setupModels.has(setup.recommendedModel)) fail(setupFile + '.recommendedModel', '未知 Anima 安装模型');
  if (usesAnimaConversion) {
    for (const id of ['qwen-encoder', 'qwen-vae']) {
      if (setupModels.get(id)?.kind !== 'image') fail(setupFile, '缺少 Anima 转换组件 ' + id);
    }
    if (!managedModels.has('anima-base-v1.0')) fail(managedFile, '缺少 Anima 转换所需基础模型');
  }
  for (const [id, bundle] of managedModels) {
    const at = managedFile + '.models.' + id;
    if (!models.has(id)) fail(at, '图像目录没有对应模型');
    addNative(id, at);
    checkArtifacts(bundle, at);
  }
  for (const [id, bundle] of adapterBundles) {
    const at = managedAdapterFile + '.models.' + id;
    if (!adapters.has(id)) fail(at, '适配器清单没有对应模型');
    addNative(id, at);
    const paths = checkArtifacts(bundle, at, true);
    const localPack = adapters.get(id)?.localPack;
    if (isRow(localPack)) {
      const field = adapterFile + '.models.' + id + '.localPack.configs';
      for (const config of array(localPack.configs, field)) {
        if (!isId(config) || !paths.has(config)) fail(field, '托管包缺少配置文件 ' + String(config));
      }
    }
  }
  for (const [id, model] of adapters) {
    const at = adapterFile + '.models.' + id;
    if (typeof model.runner === 'string' && separateRunner.has(model.runner)) {
      for (const [role, component] of Object.entries(map(model.components, at + '.components'))) {
        if (!isId(component) || !keyframeAssets.has(component)) {
          fail(at + '.components.' + role, '未知素材 ID ' + String(component));
        }
      }
      continue;
    }
    if (!adapterBundles.has(id)) fail(at, '缺少对应的托管适配器包');
    if (model.runner !== 'longcat-avatar') {
      const layout = model.layout ?? model.pipeline;
      if (!isId(layout) || !layouts.has(layout)) fail(at, '未知适配器布局 ' + String(layout));
    }
  }
  for (const [id, bundle] of auxiliaryBundles) checkArtifacts(bundle, auxiliaryFile + '.resources.' + id);

  const serverFiles = map(map(adapter.keyframeRuntime, adapterFile + '.keyframeRuntime').serverFiles,
    adapterFile + '.keyframeRuntime.serverFiles');
  for (const [file, digest] of Object.entries(serverFiles)) {
    if (!hasDigest(digest, sha256)) fail(adapterFile + '.keyframeRuntime.serverFiles.' + file, 'SHA-256 格式无效');
  }
  for (const [file, manifest] of manifests) checkFields(manifest, file, file !== mirrorsFile);
  const mirrorRows = manifests.has(mirrorsFile) ? rows(mirrors.files, mirrorsFile + '.files') : [];
  const mirrorIdentities = new Set<string>();
  for (const [i, mirror] of mirrorRows.entries()) {
    const at = mirrorsFile + '.files[' + i + ']';
    const identity = artifactIdentity(mirror.sourceUrl, mirror);
    if (!identity || !primaryArtifacts.has(identity)) fail(at, '没有同来源 URL、字节数和 SHA-256 的主清单文件');
    if (!isId(mirror.mirrorUrl)) fail(at, '缺少镜像 URL');
    if (identity && mirrorIdentities.has(identity)) fail(at, '重复镜像来源和校验信息');
    if (identity) mirrorIdentities.add(identity);
  }

  // The JSON declares models and layouts. Rust owns the Python entry points and packaged worker file list.
  for (const rust of [
    'runtime-rs/src/generation/native/adapters.rs',
    'runtime-rs/src/control/native_setup.rs',
    'runtime-rs/src/control/native_setup/activation.rs',
    'runtime-rs/src/control/native_setup/anima_models.rs',
    'runtime-rs/src/control/native_setup/image_models.rs',
    'runtime-rs/src/control/native_setup/local_adapters.rs',
  ]) {
    const source = readScriptSource(rust);
    const references = new Set(
      [...source.matchAll(/"((?:(?:scripts\/maintenance|tools\/inference)\/[\w/-]*?)?[\w-]+\.py)"/g)]
        .map(match => match[1]),
    );
    for (const reference of references) {
      const file = reference.includes('/') ? reference : 'tools/inference/' + reference;
      if (!statSync(resolve(root, file), { throwIfNoEntry: false })?.isFile()) fail(rust, '找不到脚本 ' + file);
    }
  }

  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log('模型清单检查通过。已核对 ' + manifests.size + ' 份清单、' + mirrorRows.length + ' 条镜像。');
  console.log('Git 固定对象 ' + (gitPinned.size - gitLfs) + ' 项，Git LFS 固定指针 ' + gitLfs + ' 项。');
}
check();
