import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildProjects } from './build-node.mts';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_INPUTS = new Set(['server.ts', 'eslint.config.mts', 'package.json', 'package-lock.json',
  'tsconfig.node.json', 'tsconfig.runtime.json', 'tsconfig.tests.json', 'tsconfig.browser-tools.json']);
const SOURCE_DIRECTORIES = ['server', 'routes', 'services', 'scripts', 'tools', 'src', 'docs/guides/prompts', 'poc'];

interface DevelopmentOptions {
  watch?: boolean;
  debounceMs?: number;
  build?: () => boolean;
  start?: () => ChildProcess;
  reportError?: (error: any) => void;
}

/** Rebuild before restarting; a failed check leaves the last working gateway running. */
export async function startDevelopment(root = defaultRoot, options: DevelopmentOptions = {}) {
  root = path.resolve(root);
  const build = options.build || (() => buildProjects(root).some(result => !result.cached));
  const start = options.start || (() => spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root, stdio: 'inherit', env: process.env, windowsHide: true,
  }));
  const reportError = options.reportError || ((error: any) => console.error(
    error instanceof Error ? error.message : String(error)));
  const watchers: fs.FSWatcher[] = [];
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let requested = false;
  let closed = false;

  async function stopChild() {
    const previous = child;
    child = undefined;
    if (!previous || previous.exitCode !== null || previous.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const force = setTimeout(() => previous.kill('SIGKILL'), 2500);
      force.unref();
      previous.once('close', () => { clearTimeout(force); resolve(); });
      previous.kill('SIGTERM');
    });
  }

  function rebuild(): Promise<void> {
    if (closed) return Promise.resolve();
    requested = true;
    if (running) return running;
    running = Promise.resolve().then(async () => {
      while (requested && !closed) {
        requested = false;
        try {
          const changed = build();
          if (!closed && (!child || changed)) {
            await stopChild();
            if (closed) break;
            const started = start();
            child = started;
            started.once('error', reportError);
            started.once('close', () => { if (child === started) child = undefined; });
          }
        } catch (error) { reportError(error); }
      }
    }).finally(() => { running = undefined; });
    return running;
  }

  function schedule(relative: string) {
    relative = relative.replaceAll('\\', '/');
    if (closed || relative.startsWith('scripts/archive/') || relative.includes('/vendor/')) return;
    if (!ROOT_INPUTS.has(relative) && (!/\.[cm]?ts$/.test(relative) || /\.d\.[cm]?ts$/.test(relative))) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void rebuild(); }, options.debounceMs ?? 120);
  }

  function watch(directory: string, recursive: boolean) {
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) return;
    const watcher = fs.watch(absolute, { recursive }, (_event, filename) => {
      if (filename) schedule(path.join(directory, String(filename)));
    });
    watcher.on('error', reportError);
    watchers.push(watcher);
  }

  if (options.watch !== false) {
    watch('', false);
    watch('assets', false);
    for (const directory of SOURCE_DIRECTORIES) watch(directory, true);
  }
  await rebuild();
  return {
    rebuild,
    get pid() { return child?.pid; },
    async close() {
      closed = true;
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      await running;
      await stopChild();
    },
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.slice(2).some(argument => argument === '--help' || argument === '--plan')) {
    console.log('dev-server.mts\nWatch TypeScript sources, build with strict checks, then restart the local gateway.\nType errors preserve the last running build; Ctrl+C closes watchers and the gateway.');
  } else if (process.argv.length > 2) {
    console.error('Unknown arguments. Use --help for usage.');
    process.exitCode = 2;
  } else {
    try {
      const session = await startDevelopment();
      let stopping = false;
      const close = () => {
        if (stopping) return;
        stopping = true;
        void session.close().then(() => { process.exitCode = 0; });
      };
      process.on('SIGINT', close);
      process.on('SIGTERM', close);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
