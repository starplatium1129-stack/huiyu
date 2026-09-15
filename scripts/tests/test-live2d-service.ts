'use strict';

import { PathOrFileDescriptor } from 'node:fs';

const { test }: typeof import('node:test') = require('node:test');

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const live2d: typeof import('../../services/live2d-service') = require('../../services/live2d-service');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-live2d-'));

function write(filePath: PathOrFileDescriptor, body: string|NodeJS.ArrayBufferView<ArrayBufferLike>) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
}

test('live2d-service: complete model, path escape, missing assets, status', () => {
try {
  const completeDir = path.join(root, 'nene');
  write(
    path.join(completeDir, 'nene.model3.json'),
    JSON.stringify({
      FileReferences: {
        Moc: 'nene.moc3',
        Textures: ['texture_00.png'],
        Expressions: [{ File: 'exp/happy.exp3.json' }],
        Motions: {
          Idle: [{ File: 'motion/idle.motion3.json', Sound: 'sound/idle.wav' }]
        }
      }
    })
  );
  write(path.join(completeDir, 'nene.moc3'), 'moc');
  write(path.join(completeDir, 'texture_00.png'), 'png');
  write(path.join(completeDir, 'exp', 'happy.exp3.json'), '{}');
  write(path.join(completeDir, 'motion', 'idle.motion3.json'), '{}');
  write(path.join(completeDir, 'sound', 'idle.wav'), 'wav');

  const complete = live2d.inspectModel(root, 'nene');
  assert.strictEqual(complete.available, true);
  assert.strictEqual(complete.source, 'project-local');
  assert.strictEqual(complete.modelUrl, '/assets/live2d-current/nene/nene.model3.json');
  assert.deepStrictEqual(complete.missing, []);

  const incompleteDir = path.join(root, 'natsume');
  write(
    path.join(incompleteDir, 'natsume.model3.json'),
    JSON.stringify({
      FileReferences: {
        Moc: 'natsume.moc3',
        Textures: ['../escape.png', 'missing.png']
      }
    })
  );
  write(path.join(incompleteDir, 'natsume.moc3'), 'moc');

  const incomplete = live2d.inspectModel(root, 'natsume');
  assert.strictEqual(incomplete.available, false);
  assert.strictEqual(incomplete.source, 'incomplete-model');
  assert(incomplete.missing.includes('../escape.png'), 'path escape must be treated as missing');
  assert(incomplete.missing.includes('missing.png'), 'absent texture must be reported');

  const refs = live2d.collectReferences({
    FileReferences: {
      Moc: 'a.moc3',
      Physics: 'a.physics3.json',
      Textures: ['t.png'],
      Expressions: [{ File: 'e.json' }],
      Motions: { Tap: [{ File: 'm.json', Sound: 's.wav' }] }
    }
  });
  assert.deepStrictEqual(refs, ['a.moc3', 'a.physics3.json', 't.png', 'e.json', 'm.json', 's.wav']);

  const service = live2d.createLive2dService({ rootDir: root, characters: ['nene', 'natsume', 'missing'] });
  const status = service.status();
  assert.strictEqual(status.available, true);
  assert.deepStrictEqual(status.characters, ['nene']);
  assert.strictEqual(status.models.missing.source, 'missing');

  console.log('Live2D service tests passed: complete model, path escape, missing assets, status');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
});
