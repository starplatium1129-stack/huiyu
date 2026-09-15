import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

import { PathOrFileDescriptor } from 'node:fs';

const crypto: typeof import('node:crypto') = require('node:crypto');
const { execFileSync, spawn }: typeof import('node:child_process') = require('node:child_process');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { TextDecoder }: typeof import('node:util') = require('node:util');

const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
const TARGET_ORDER = new Map([
  ['index', 0],
  ['worktree', 1],
  ['untracked', 2],
]);
const CRLF_EXTENSIONS = new Set(['.bat', '.cmd', '.ps1']);
const TEXT_EXTENSIONS = new Set([
  '.bat', '.c', '.cc', '.cfg', '.cjs', '.cmd', '.conf', '.cpp', '.css', '.csv',
  '.h', '.hpp', '.html', '.ini', '.java', '.js', '.json', '.json5', '.jsx',
  '.lock', '.md', '.mjs', '.mts', '.properties', '.ps1', '.py', '.rs', '.sh',
  '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt', '.vue', '.wgsl', '.xml',
  '.yaml', '.yml', '.nsi', '.nsh', '.cs', '.xaml', '.manifest',
]);
const BINARY_EXTENSIONS = new Set([
  '.7z', '.avif', '.bin', '.bmp', '.db', '.dll', '.dylib', '.eot', '.exe',
  '.gif', '.ico', '.jpeg', '.jpg', '.lib', '.moc3', '.mp3', '.mp4', '.ogg',
  '.otf', '.pdf', '.png', '.pptx', '.safetensors', '.so', '.sqlite', '.ttf',
  '.wav', '.webm', '.webp', '.woff', '.woff2', '.zip',
]);
const TEXT_FILENAMES = new Set([
  '.editorconfig', '.env', '.env.example', '.eslintignore', '.gitattributes',
  '.gitignore', '.gitkeep', '.npmrc', '.nvmrc', '.prettierignore', '.prettierrc', 'pre-push',
  'dockerfile', 'license', 'makefile',
]);

function compareStrings(left: number, right: number) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function gitErrorMessage(error: unknown) {
  const stderr = Buffer.isBuffer(error.stderr)
    ? error.stderr.toString('utf8').trim()
    : String(error.stderr || '').trim();
  return stderr || error.message;
}

function runGit(repositoryRoot: string, args: unknown[]|readonly string[], options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repositoryRoot,
      encoding: options.encoding === undefined ? null : options.encoding,
      input: options.input,
      maxBuffer: MAX_GIT_OUTPUT,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`git ${args.join(' ')} failed: ${gitErrorMessage(error)}`, { cause: error });
  }
}

function resolveRepositoryRoot(startPath: string) {
  const requestedRoot = path.resolve(startPath);
  const output = runGit(requestedRoot, ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const repositoryRoot = output.trim();
  if (!repositoryRoot) throw new Error('git rev-parse returned an empty repository root');
  return path.resolve(repositoryRoot);
}

function splitNullTerminated(output: string) {
  const source = output.toString('utf8');
  if (source && !source.endsWith('\0')) {
    throw new Error('Git returned malformed non-NUL-terminated path output');
  }
  return source.split('\0').filter(Boolean);
}

function parseIndexEntries(output: string) {
  return splitNullTerminated(output).map((record: string) => {
    const separator = record.indexOf('\t');
    if (separator < 0) throw new Error(`Git returned a malformed index record: ${record}`);
    const metadata = record.slice(0, separator).split(' ');
    if (metadata.length !== 3 || !/^[0-7]{6}$/.test(metadata[0])
      || !/^[0-9a-f]{40,64}$/i.test(metadata[1]) || !/^[0-3]$/.test(metadata[2])) {
      throw new Error(`Git returned a malformed index record: ${record}`);
    }
    return {
      mode: metadata[0],
      objectId: metadata[1].toLowerCase(),
      stage: Number(metadata[2]),
      path: record.slice(separator + 1),
    };
  });
}

function classifyPath(relativePath: string) {
  const basename = path.posix.basename(relativePath).toLowerCase();
  const extension = path.posix.extname(basename).toLowerCase();
  if (TEXT_FILENAMES.has(basename) || TEXT_EXTENSIONS.has(extension)) return 'text';
  if (BINARY_EXTENSIONS.has(extension)) return 'binary';
  return 'unknown';
}

function sha256(bytes: string|NodeJS.ArrayBufferView<ArrayBufferLike>) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validateAllowance(entry: any, index: number) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Debt allowance ${index} must be an object`);
  }
  const keys = Object.keys(entry).sort(compareStrings);
  if (keys.length !== 2 || keys[0] !== 'path' || keys[1] !== 'sha256') {
    throw new Error(`Debt allowance ${index} may contain only path and sha256`);
  }
  if (typeof entry.path !== 'string' || !entry.path || entry.path.includes('\\')
    || path.posix.isAbsolute(entry.path) || path.posix.normalize(entry.path) !== entry.path
    || entry.path === '..' || entry.path.startsWith('../')) {
    throw new Error(`Debt allowance ${index} has an invalid repository path`);
  }
  if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    throw new Error(`Debt allowance ${index} must use a lowercase full-blob SHA-256`);
  }
  return entry;
}

function normalizeAllowances(allowances = []) {
  if (!Array.isArray(allowances)) throw new Error('Debt allowances must be an array');
  const lookup = new Map();
  for (let index = 0; index < allowances.length; index += 1) {
    const entry = validateAllowance(allowances[index], index);
    let hashes = lookup.get(entry.path);
    if (!hashes) {
      hashes = new Set();
      lookup.set(entry.path, hashes);
    }
    if (hashes.has(entry.sha256)) {
      throw new Error(`Duplicate debt allowance for ${entry.path} at ${entry.sha256}`);
    }
    hashes.add(entry.sha256);
  }
  return lookup;
}

function loadDebtFixture(fixturePath: PathOrFileDescriptor) {
  let fixture;
  try {
    fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read repository hygiene debt fixture: ${runtimeErrorMessage(error)}`, { cause: error });
  }
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)
    || fixture.version !== 1 || !Array.isArray(fixture.allowances)) {
    throw new Error('Repository hygiene debt fixture must contain version 1 and an allowances array');
  }
  normalizeAllowances(fixture.allowances);
  return fixture.allowances;
}

async function loadDebtFromGitRef(startPath: string, reference: string) {
  if (typeof reference !== 'string' || !reference.trim()) {
    throw new Error('Repository hygiene baseline ref is required');
  }
  const repositoryRoot = resolveRepositoryRoot(startPath);
  const records = splitNullTerminated(runGit(
    repositoryRoot,
    ['ls-tree', '-r', '-z', '--full-tree', reference.trim()],
  ));
  const candidates = [];
  for (const record of records) {
    const separator = record.indexOf('\t');
    if (separator < 0) throw new Error(`Git returned a malformed tree record: ${record}`);
    const metadata = record.slice(0, separator).split(' ');
    const relativePath = record.slice(separator + 1);
    if (metadata.length !== 3 || metadata[1] !== 'blob' || !/^[0-9a-f]{40,64}$/i.test(metadata[2])) {
      continue;
    }
    if (classifyPath(relativePath) !== 'text') continue;
    candidates.push({ relativePath, objectId: metadata[2].toLowerCase() });
  }
  // 批量读取（单进程），替代逐 blob spawn
  const blobs = await catFileBatch(repositoryRoot, candidates.map((c) => c.objectId));
  const allowances = [];
  for (const candidate of candidates) {
    const bytes = blobs.get(candidate.objectId);
    if (!bytes) throw new Error(`git cat-file --batch missed blob ${candidate.objectId} (${candidate.relativePath})`);
    if (scanText(bytes, '\n').length > 0) {
      allowances.push({ path: candidate.relativePath, sha256: sha256(bytes) });
    }
  }
  return allowances;
}

function positionAt(source: string[], targetIndex: number) {
  let line = 1;
  let column = 1;
  for (let index = 0; index < targetIndex; index += 1) {
    if (source[index] === '\r') {
      if (source[index + 1] === '\n') index += 1;
      line += 1;
      column = 1;
    } else if (source[index] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function textViolation(kind: string, message: string, source: string, index: number) {
  const location = positionAt(source, index);
  return { kind, message, ...location };
}

function scanText(bytes: NodeJS.AllowSharedBufferSource|undefined, expectedEol: string, relativePath = '') {
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return [{ kind: 'invalid-utf8', message: 'invalid UTF-8' }];
  }

  const violations = [];
  /* Windows PowerShell 5.1 读取无 BOM 的 UTF-8 脚本时按系统 ANSI 代码页解码，
     含中文的 .ps1 会整片乱码（deploy-desktop-quick.ps1 有 1000+ 中文字符，
     .gitattributes 亦规定 *.ps1 走 crlf）。故 .ps1 必须保留 BOM —— 此处放行，
     避免门禁逼出一份「一执行就乱码」的部署脚本。 */
  const bomAllowed = path.posix.extname(relativePath).toLowerCase() === '.ps1';
  if (!bomAllowed) {
    for (let index = source.indexOf('\ufeff'); index >= 0; index = source.indexOf('\ufeff', index + 1)) {
      violations.push(textViolation('bom', 'UTF-8 BOM is not allowed', source, index));
    }
  }

  const controlPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
  for (const match of source.matchAll(controlPattern)) {
    const code = match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    violations.push(textViolation(
      'control',
      `illegal control character U+${code}`,
      source,
      match.index,
    ));
  }

  const trailingPattern = /[ \t]+(?=\r\n|\r|\n|$)/g;
  for (const match of source.matchAll(trailingPattern)) {
    violations.push(textViolation(
      'trailing-whitespace',
      'trailing whitespace',
      source,
      match.index,
    ));
  }

  if (source.length > 0 && !source.endsWith('\n') && !source.endsWith('\r')) {
    violations.push(textViolation(
      'missing-final-newline',
      'text file must end with a newline',
      source,
      source.length,
    ));
  }

  const expectedName = expectedEol === '\r\n' ? 'CRLF' : 'LF';
  for (let index = 0; index < source.length; index += 1) {
    let actual = null;
    if (source[index] === '\r') {
      if (source[index + 1] === '\n') {
        actual = '\r\n';
        index += 1;
      } else {
        actual = '\r';
      }
    } else if (source[index] === '\n') {
      actual = '\n';
    }
    if (actual && actual !== expectedEol) {
      const actualName = actual === '\r\n' ? 'CRLF' : actual === '\n' ? 'LF' : 'CR';
      const locationIndex = actual === '\r\n' ? index - 1 : index;
      violations.push(textViolation(
        'line-ending',
        `unexpected ${actualName} line ending; expected ${expectedName}`,
        source,
        locationIndex,
      ));
    }
  }

  return violations;
}

function expectedLineEnding(target: string, relativePath: string) {
  if (target === 'index') return '\n';
  return CRLF_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase()) ? '\r\n' : '\n';
}

/**
 * 单进程批量读取 blob 内容（`git cat-file --batch`）。
 * Windows 上每次 spawn 约 30-80ms，逐 blob 调用在千级文件规模下产生
 * 数十秒的纯进程创建开销——这是扫描耗时的主要来源（2026-08-22 提速）。
 * 返回 Map<小写 oid, Buffer>；--batch 按输入顺序逐帧输出。
 */
function catFileBatch(repositoryRoot: string, objectIds: unknown[]) {
  const unique = [...new Set(objectIds.map((id: string) => id.toLowerCase()))];
  if (unique.length === 0) return Promise.resolve(new Map());
  const child = spawn('git', ['cat-file', '--batch'], {
    cwd: repositoryRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT,
  });
  const chunks: unknown[]|readonly Uint8Array<ArrayBufferLike>[] = [];
  let stderr = '';
  child.stdout.on('data', (chunk: unknown) => chunks.push(chunk));
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  for (const id of unique) child.stdin.write(`${id}\n`);
  child.stdin.end();
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code: number) => {
      if (code !== 0) {
        reject(new Error(`git cat-file --batch failed (${code}): ${stderr.trim() || 'no stderr'}`));
        return;
      }
      try {
        const buffer = Buffer.concat(chunks);
        const map = new Map();
        let offset = 0;
        for (const requested of unique) {
          const newlineAt = buffer.indexOf(0x0a, offset);
          if (newlineAt < 0) throw new Error(`truncated header for ${requested}`);
          const parts = buffer.slice(offset, newlineAt).toString('utf8').split(' ');
          if (parts.length !== 3 || parts[2] === 'missing') {
            throw new Error(`cannot resolve ${requested}: ${parts.join(' ')}`);
          }
          const size = Number(parts[2]);
          if (!Number.isInteger(size) || size < 0) {
            throw new Error(`malformed size for ${requested}: ${parts[2]}`);
          }
          const contentStart = newlineAt + 1;
          map.set(requested, buffer.slice(contentStart, contentStart + size));
          offset = contentStart + size + 1; // 跳过帧尾换行
        }
        resolve(map);
      } catch (error) {
        reject(new Error(`git cat-file --batch parse failed: ${runtimeErrorMessage(error)}`));
      }
    });
  });
}

function unknownViolation(target: string, relativePath: string) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  const label = extension || path.posix.basename(relativePath);
  return {
    target,
    path: relativePath,
    kind: 'unknown-file-type',
    message: `unknown file type "${label}"; classify it explicitly as text or binary`,
  };
}

function appendBlobViolations(result: any, target: string, relativePath: string|undefined, bytes: NonSharedBuffer, allowanceLookup: Map<unknown,unknown>) {
  const violations = scanText(bytes, expectedLineEnding(target, relativePath), relativePath);
  if (violations.length === 0) return;
  const digest = sha256(bytes);
  const allowed = target !== 'untracked' && allowanceLookup.get(relativePath)?.has(digest);
  if (allowed) {
    result.allowed.push({ target, path: relativePath, sha256: digest, count: violations.length });
    return;
  }
  for (const violation of violations) {
    result.violations.push({ target, path: relativePath, ...violation });
  }
}

function repositoryPath(repositoryRoot: string, relativePath: string) {
  const absolutePath = path.resolve(repositoryRoot, ...relativePath.split('/'));
  const relative = path.relative(repositoryRoot, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Git returned an unsafe repository path: ${relativePath}`);
  }
  return absolutePath;
}

function readWorktreeBlob(repositoryRoot: string, relativePath: string, target: string, result: any) {
  const absolutePath = repositoryPath(repositoryRoot, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if (target === 'worktree' && runtimeErrorCode(error) === 'ENOENT') return null;
    throw new Error(`Unable to inspect ${target} file ${relativePath}: ${runtimeErrorMessage(error)}`, { cause: error });
  }
  if (!stat.isFile()) {
    result.violations.push({
      target,
      path: relativePath,
      kind: 'unsupported-file-type',
      message: 'repository entry is not a regular file',
    });
    return null;
  }
  try {
    return fs.readFileSync(absolutePath);
  } catch (error) {
    throw new Error(`Unable to read ${target} file ${relativePath}: ${runtimeErrorMessage(error)}`, { cause: error });
  }
}

function scanWorktreeTarget(repositoryRoot: string, relativePaths: unknown[], target: string, allowanceLookup: Map<unknown,unknown>, result: any) {
  for (const relativePath of relativePaths) {
    const bytes = readWorktreeBlob(repositoryRoot, relativePath, target, result);
    if (bytes === null) continue;
    result.counts[target] += 1;
    const classification = classifyPath(relativePath);
    if (classification === 'unknown') {
      result.violations.push(unknownViolation(target, relativePath));
    } else if (classification === 'text') {
      appendBlobViolations(result, target, relativePath, bytes, allowanceLookup);
    }
  }
}

function sortViolations(violations: unknown[]) {
  violations.sort((left: any, right: any) => {
    const targetDifference = TARGET_ORDER.get(left.target) - TARGET_ORDER.get(right.target);
    if (targetDifference !== 0) return targetDifference;
    const pathDifference = compareStrings(left.path, right.path);
    if (pathDifference !== 0) return pathDifference;
    const lineDifference = (left.line || Number.MAX_SAFE_INTEGER) - (right.line || Number.MAX_SAFE_INTEGER);
    if (lineDifference !== 0) return lineDifference;
    const columnDifference = (left.column || Number.MAX_SAFE_INTEGER)
      - (right.column || Number.MAX_SAFE_INTEGER);
    if (columnDifference !== 0) return columnDifference;
    return compareStrings(left.kind, right.kind);
  });
}

async function scanRepository(startPath: string, options = {}) {
  const repositoryRoot = resolveRepositoryRoot(startPath);
  const allowanceLookup = normalizeAllowances(options.allowances || []);
  const result = {
    repositoryRoot,
    counts: { index: 0, worktree: 0, untracked: 0 },
    violations: [],
    allowed: [],
  };

  const indexEntries = parseIndexEntries(runGit(repositoryRoot, ['ls-files', '--stage', '-z']));
  const entriesByPath = new Map();
  for (const entry of indexEntries) {
    const entries = entriesByPath.get(entry.path) || [];
    entries.push(entry);
    entriesByPath.set(entry.path, entries);
  }

  const trackedEntries = [];
  const textIndexEntries = [];
  for (const relativePath of [...entriesByPath.keys()].sort(compareStrings)) {
    const entries = entriesByPath.get(relativePath);
    const stages = [...new Set(entries.map((entry: any) => entry.stage))].sort();
    if (stages.some((stage) => stage !== 0)) {
      result.violations.push({
        target: 'index',
        path: relativePath,
        kind: 'unmerged-index-entry',
        message: `unmerged index entry (stages ${stages.join(', ')})`,
      });
      continue;
    }
    if (entries.length !== 1) throw new Error(`Git returned duplicate stage-zero entries for ${relativePath}`);
    const entry = entries[0];
    result.counts.index += 1;
    if (entry.mode !== '100644' && entry.mode !== '100755') {
      result.violations.push({
        target: 'index',
        path: relativePath,
        kind: 'unsupported-index-mode',
        message: `unsupported index mode ${entry.mode}`,
      });
      continue;
    }
    trackedEntries.push(entry);
    const classification = classifyPath(relativePath);
    if (classification === 'unknown') {
      result.violations.push(unknownViolation('index', relativePath));
    } else if (classification === 'text') {
      textIndexEntries.push(entry);
    }
  }

  // 索引侧文本 blob 一次性批量读取（替代逐文件 spawn cat-file 的主要瓶颈）
  const indexBlobs = await catFileBatch(
    repositoryRoot,
    textIndexEntries.map((entry) => entry.objectId),
  );
  for (const entry of textIndexEntries) {
    appendBlobViolations(
      result,
      'index',
      entry.path,
      indexBlobs.get(entry.objectId.toLowerCase()),
      allowanceLookup,
    );
  }

  scanWorktreeTarget(
    repositoryRoot,
    trackedEntries.map((entry) => entry.path).sort(compareStrings),
    'worktree',
    allowanceLookup,
    result,
  );

  const untrackedPaths = splitNullTerminated(runGit(
    repositoryRoot,
    ['ls-files', '--others', '--exclude-per-directory=.gitignore', '-z'],
  )).sort(compareStrings);
  scanWorktreeTarget(repositoryRoot, untrackedPaths, 'untracked', allowanceLookup, result);

  sortViolations(result.violations);
  result.allowed.sort((left, right) => {
    const pathDifference = compareStrings(left.path, right.path);
    return pathDifference || TARGET_ORDER.get(left.target) - TARGET_ORDER.get(right.target);
  });
  return result;
}

function formatViolation(violation: any) {
  const line = violation.line ? `:${violation.line}` : '';
  const column = violation.column ? `:${violation.column}` : '';
  return `${violation.target}:${violation.path}${line}${column}: ${violation.message}`;
}

export = {
  classifyPath,
  formatViolation,
  loadDebtFromGitRef,
  loadDebtFixture,
  scanRepository,
  scanText,
  sha256,
};
