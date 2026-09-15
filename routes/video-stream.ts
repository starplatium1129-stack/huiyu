'use strict';

import { PathLike } from 'node:fs';



let fs: typeof import('fs') = require('fs');


// 结果文件 Range 流式下发（支持视频拖动进度条）。
function streamVideo(req: { headers: { range: unknown; }; }, res: { setHeader: (arg0: string,arg1: string) => void; status: (arg0: number) => { (): unknown; new(): unknown; setHeader: { (arg0: string,arg1: string): void; new(): unknown; }; }; end: () => void; }, result: { path: PathLike; mime: unknown; }) {
  let stat = fs.statSync(result.path);
  let range = String(req.headers.range || '');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', result.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!range) {
    res.setHeader('Content-Length', String(stat.size));
    fs.createReadStream(result.path).pipe(res);
    return;
  }
  let match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    res.status(416).setHeader('Content-Range', 'bytes */' + stat.size);
    res.end();
    return;
  }
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= stat.size) {
    res.status(416).setHeader('Content-Range', 'bytes */' + stat.size);
    res.end();
    return;
  }
  res.status(206);
  res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + stat.size);
  res.setHeader('Content-Length', String(end - start + 1));
  fs.createReadStream(result.path, { start:start, end:end }).pipe(res);
}
export = { streamVideo };
