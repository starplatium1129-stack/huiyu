'use strict';

const io: typeof import('./maintenance-recovery-fs') = require('./maintenance-recovery-fs');
const { VERSIONED_FILES }: typeof import('./data-version') = require('./data-version');

function captureMaintenanceSnapshot(options: any, store: any, deletedIds: any = []) {
  const ctx = io.context(options);
  if (!io.samePath(store.shardsDir, io.path.join(ctx.rootDir, 'data/scenes'))) throw io.failure('MAINTENANCE_PATH', '场景存储根与事务根不符');
  const files = VERSIONED_FILES.flatMap(name => ['', '.gz', '.br'].map(ext => io.path.join(ctx.rootDir, 'data', name + ext)));
  files.push(io.path.join(ctx.rootDir, 'src/stores/sceneStore.ts'), io.path.join(store.shardsDir, 'manifest.json'), io.path.join(ctx.rootDir, 'data/retired-scenes.json'));
  for (const item of store.loadSceneShards().sources) files.push(item.source);
  if (ctx.showcaseRoot) {
    files.push(io.path.join(ctx.showcaseRoot, 'manifest.json'));
    for (const id of deletedIds) {
      if (!/^sc[0-9]+$/.test(id)) throw io.failure('MAINTENANCE_PATH', '样张删除身份无效');
      for (const dir of ['images', 'thumbs']) for (const ext of ['jpg', 'png', 'webp']) files.push(io.path.join(ctx.showcaseRoot, dir, id + '.' + ext));
    }
  }
  for (const file of [...files]) {
    io.targetPath(ctx, file);
    if (file.endsWith('.json')) for (const ext of ['gz', 'br']) if (io.safePath(file + '.' + ext)) files.push(file + '.' + ext);
  }
  return io.snapshotFiles(files);
}
export = { captureMaintenanceSnapshot };
