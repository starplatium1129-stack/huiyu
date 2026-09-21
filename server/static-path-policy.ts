'use strict';

/** Private candidate assets never belong to the generic static namespace. */
function isPrivateAssetPath(value: string): boolean {
  let pathname: string;
  try { pathname = decodeURIComponent(String(value || '')); } catch { return false; }
  return /^\/(?:assets\/)?live2d-candidates(?:\/|$)/i.test(pathname);
}

function rejectPrivateAssetPath(req: { path?: string }, res: { status: (code: number) => { end: () => unknown } }, next: () => void) {
  if (isPrivateAssetPath(String(req.path || ''))) return res.status(404).end();
  next();
}

export = { isPrivateAssetPath, rejectPrivateAssetPath };
