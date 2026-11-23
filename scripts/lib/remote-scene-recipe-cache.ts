import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker, parentPort, workerData } from 'node:worker_threads';
import safe = require('./delivery-paths');
import type { CompiledRecipe, Row } from './remote-scene-recipes';

const FILE = 'remote-scene-recipes.sqlite';
const CACHE = 'runtime/desktop-build-cache';
const COMPILER = './remote-scene-recipes';
type Job = { recipeRows: SharedArrayBuffer; lane: number; lanes: number; compilerSha256: string };
type PackedRecipes = { data: Uint8Array; entries: (Omit<CompiledRecipe, 'data'> & { start: number; end: number })[] };
type CacheReceipt = { inputs: string; sha256: string; count: number };
let loaded: { compiler: typeof import('./remote-scene-recipes'); files: string[]; digest: string } | undefined;

function compilerDigest(files: string[]) {
  const hash = createHash('sha256').update(JSON.stringify(process.versions));
  for (const file of files) hash.update(JSON.stringify([file, safe.sha256(fs.readFileSync(file))]));
  return hash.digest('hex');
}

function loadCompiler() {
  if (!loaded) {
    const files = new Set([__filename, path.resolve(__dirname, '../../package.json')]);
    // CommonJS's module.children omits transitive ES module imports.
    const hooks = registerHooks({
      resolve(specifier, context, next) {
        const resolution = next(specifier, context);
        if (resolution.url.startsWith('file:')) files.add(fileURLToPath(resolution.url));
        return resolution;
      },
    });
    try {
      const compiler: typeof import('./remote-scene-recipes') = require(COMPILER);
      const dependencies = [...files].sort();
      loaded = { compiler, files: dependencies, digest: compilerDigest(dependencies) };
    } finally {
      hooks.deregister();
    }
  }
  return loaded;
}

function runJob({ recipeRows, lane, lanes, compilerSha256 }: Job) {
  const { compiler, digest } = loadCompiler();
  if (digest !== compilerSha256) throw Error('并行编译期间场景配方编译器已变化');
  const rows: Row[] = JSON.parse(Buffer.from(recipeRows).toString('utf8'));
  const records = [...compiler.compileRecipes(rows, lane, lanes)];
  const data = new Uint8Array(records.reduce((bytes, record) => bytes + record.data.byteLength, 0));
  let offset = 0;
  const entries = records.map(({ data: recipe, ...entry }) => {
    const start = offset;
    data.set(recipe, offset);
    offset += recipe.byteLength;
    return { ...entry, start, end: offset };
  });
  parentPort!.postMessage({ data, entries } satisfies PackedRecipes, [data.buffer]);
}
if (parentPort && workerData?.recipeRows instanceof SharedArrayBuffer) runJob(workerData as Job);

async function parallelRecipes(rows: Buffer, lanes: number, compilerSha256: string) {
  const recipeRows = new SharedArrayBuffer(rows.byteLength);
  new Uint8Array(recipeRows).set(rows);
  const workers: Worker[] = [];
  try {
    const batches = await Promise.all(Array.from({ length: lanes }, (_, lane) => new Promise<PackedRecipes>((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: { recipeRows, lane, lanes, compilerSha256 } satisfies Job });
      workers.push(worker);
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => reject(Error(`场景配方编译线程 ${lane + 1} 退出 (${code})`)));
    })));
    return batches.flatMap(({ data, entries }) => entries.map(({ start, end, ...entry }) => ({
      ...entry, data: data.subarray(start, end),
    }))).sort((a, b) => a.order - b.order);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}

function restore(root: string, destination: string, inputs: string) {
  let receipt: CacheReceipt, bytes: Buffer;
  try {
    receipt = JSON.parse(fs.readFileSync(safe.resolveSafe(root, `${CACHE}/recipes.json`), 'utf8'));
    if (receipt.inputs !== inputs || !Number.isSafeInteger(receipt.count) || receipt.count <= 0) return;
    bytes = fs.readFileSync(safe.resolveSafe(root, `${CACHE}/${FILE}`));
    if (safe.sha256(bytes) !== receipt.sha256) return;
  } catch {
    return;
  }
  fs.writeFileSync(destination, bytes, { flag: 'wx' });
  return receipt.count;
}

function save(root: string, file: string, inputs: string, count: number) {
  const directory = safe.resolveSafe(root, CACHE, true);
  fs.mkdirSync(directory, { recursive: true });
  const suffix = `${randomUUID()}.tmp`;
  const database = safe.resolveSafe(root, `${CACHE}/${FILE}`, true), receipt = safe.resolveSafe(root, `${CACHE}/recipes.json`, true);
  const dataTemp = `${database}.${suffix}`, receiptTemp = `${receipt}.${suffix}`;
  try {
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(dataTemp, bytes, { flag: 'wx' });
    fs.writeFileSync(receiptTemp, JSON.stringify({ inputs, sha256: safe.sha256(bytes), count } satisfies CacheReceipt), { flag: 'wx' });
    fs.renameSync(dataTemp, database);
    // Until this rename succeeds, the old receipt cannot validate new bytes.
    fs.renameSync(receiptTemp, receipt);
  } finally {
    for (const temporary of [dataTemp, receiptTemp]) fs.rmSync(temporary, { force: true });
  }
}

export async function stageRemoteSceneRecipes(root: string, gateway: string, rows: Row[], local: boolean, logger: (message: string) => void) {
  const destination = path.join(gateway, FILE);
  if (!local) {
    const compiler: typeof import('./remote-scene-recipes') = require(COMPILER);
    return compiler.writeRecipes(destination, compiler.compileRecipes(rows));
  }
  const { compiler, files, digest } = loadCompiler();
  if (compilerDigest(files) !== digest) throw Error('场景配方编译器已变化，请重新运行桌面构建');
  const encoded = Buffer.from(JSON.stringify(rows));
  const inputs = createHash('sha256').update(digest).update(encoded).digest('hex');
  const cached = restore(root, destination, inputs);
  if (cached !== undefined) {
    logger('[stage] 复用远程场景配方缓存');
    return cached;
  }
  const lanes = Math.min(12, availableParallelism(), Math.max(1, Math.ceil(rows.length / 128)));
  logger(`[stage] 编译远程场景配方（${lanes} 线程）`);
  const recipes = lanes === 1 ? compiler.compileRecipes(rows) : await parallelRecipes(encoded, lanes, digest);
  if (compilerDigest(files) !== digest) throw Error('编译期间场景配方编译器已变化');
  const count = compiler.writeRecipes(destination, recipes);
  try {
    save(root, destination, inputs, count);
  } catch (error) {
    logger(`[stage] 远程场景配方缓存未写入：${error instanceof Error ? error.message : String(error)}`);
  }
  return count;
}
