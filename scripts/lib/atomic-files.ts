import fs from 'node:fs';
import path from 'node:path';
import type { PathLike } from 'node:fs';

/** Candidate reports create their output directory and retain the established JSON bytes. */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

/** Shard writers require an existing parent and remove temporary files after failures. */
export function writeTextAtomic(source: PathLike, content: string): void {
  const target = String(source);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, target);
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* Keep the write failure. */ }
    throw error;
  }
}
