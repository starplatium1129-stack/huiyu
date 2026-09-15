const assert: typeof import('assert') = require('assert');
const { test }: typeof import('node:test') = require('node:test');
const {
  filterImageFiles,
  buildImportedRecord,
  HISTORY_STORAGE_KEY,
  MAX_IMPORT_BATCH,
}: typeof import('../../src/utils/desktopImportCore.ts') = require('../../src/utils/desktopImportCore.ts');

function file(name: string, size = 100, type = 'image/png', blob = new Blob(['x'], { type })) {
  return { name, size, type, blob };
}

test('过滤：只留图片、跳过空文件与超大文件、批次限量', () => {
  const files = [
    file('a.png', 100, 'image/png'),
    file('b.jpg', 0, 'image/jpeg'),
    file('c.exe', 100, 'application/x-msdownload'),
    file('d.webp', 25 * 1024 * 1024, 'image/webp'),
    file('e', 50, '', ),
  ];
  assert.equal(filterImageFiles(files).length, 1);
  assert.equal(filterImageFiles(files)[0].name, 'a.png');

  const many = Array.from({ length: MAX_IMPORT_BATCH + 3 }, (_, i) => file(`m${i}.png`));
  assert.equal(filterImageFiles(many).length, MAX_IMPORT_BATCH);
});

test('无 MIME 但扩展名是图片的也放行', () => {
  const files = [file('photo.JPG', 100, '', )];
  assert.equal(filterImageFiles(files).length, 1);
});

test('buildImportedRecord：字段完整、尺寸拼接、id 唯一', () => {
  const a = buildImportedRecord(file('x.png', 100), 'img-1', { width: 1024, height: 768 });
  const b = buildImportedRecord(file('y.png', 100), 'img-2', { width: null, height: null });
  assert.equal(a.image_id, 'img-1');
  assert.equal(a.size, '1024×768');
  assert.equal(a.width, 1024);
  assert.equal(a.height, 768);
  assert.equal(a.prompt, '本地导入：x');
  assert.equal(a.favorite, false);
  assert.equal(typeof a.timestamp, 'number');
  assert.equal(a.version, 1);
  assert.equal(b.size, '本地导入');
  assert.notEqual(a.id, b.id, 'id 必须唯一');
  assert.equal(HISTORY_STORAGE_KEY, 'aics_pb_history');
});
