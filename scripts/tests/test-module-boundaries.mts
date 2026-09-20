import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ESLint } from 'eslint'
import path from 'node:path'

const lint = new ESLint({ cwd: process.cwd(), allowInlineConfig: false })
const errors = async (file: string, code: string) => (await lint.lintText(code, { filePath: path.resolve(file) }))[0].messages.filter(m => m.severity === 2)
test('pilot import boundaries accept types and reject static, dynamic, require and aliases', async () => {
  for (const code of [
    "import { useX } from '@/stores/x'; void useX",
    "import { useX } from '../stores/x'; void useX",
    "export { useX } from '../stores/x'",
    "void import('../stores/x')",
    "void import('@/utils/../stores/x')",
    "void import('/src/stores/x')",
    "void require('@/stores/x')",
    "import instance = require('@/stores/x'); void instance",
    "const target = '@/stores/x'; void import(target)",
  ]) assert.ok((await errors('src/types/fixture.ts', code)).some(m => m.ruleId === 'huiyu/module-boundaries'), code)
  for (const code of [
    "import type { State } from '@/stores/x'; export type Alias = State",
    "import { type State } from '../stores/x'; export type Alias = State",
    "import { value } from '../utils/value'; void value",
  ]) assert.deepEqual(await errors('src/types/fixture.ts', code), [], code)
  assert.ok((await errors('src/storage/fixture.ts', "void import('../views/Test.vue')")).length)
  assert.ok((await errors('src/composables/fixture.ts', "import type { Options } from 'photoswipe'; export type X = Options")).length)
  assert.deepEqual(await errors('src/components/gallery/PhotoSwipeStage.vue', '<script setup lang="ts">import Viewer from "photoswipe"; void Viewer</script><template><div /></template>'), [])
})

test('active environment rules fail on wrong globals; generated output stays ignored', async () => {
  assert.ok((await errors('src/types/fixture.ts', 'window.location.href')).some(m => m.ruleId === 'no-restricted-globals'))
  assert.equal(await lint.isPathIgnored('routes/generation.js'), true)
  assert.ok((await errors('tools/fixture.ts', 'process.cwd()')).some(m => m.ruleId === 'no-restricted-globals'))
  assert.ok((await errors('server/fixture.ts', 'document.createElement("div")')).some(m => m.ruleId === 'no-restricted-globals'))
  assert.deepEqual(await errors('tools/fixture.ts', 'document.createElement("div")'), [])
  assert.deepEqual(await errors('server/fixture.ts', 'process.cwd()'), [])
})

test('generation and workbench persistence boundaries cannot regress', async () => {
  for (const [file, code] of [
    ['server/generation/service.ts', "import router = require('../../routes/anima'); void router"],
    ['server/generation/service.ts', "import type { Request } from 'express'; export type X = Request"],
    ['server/generation/service.ts', "const p = '../../routes/anima'; void import(p)"],
    ['src/stores/promptBuilderStore.ts', "void import('@/storage/artworkRepository')"],
    ['src/composables/prompt/usePromptDraft.ts', "void import('@/stores/promptBuilderStore')"],
  ]) assert.ok((await errors(file, code)).some(m => m.ruleId === 'huiyu/module-boundaries'), code)
  assert.deepEqual(await errors('server/generation/service.ts', "import engine = require('../../routes/anima/service'); void engine"), [])
  assert.deepEqual(await errors('server/generation/validation.ts', "import type { Request } from 'express'; export type X = Request"), [])
  assert.ok((await errors('server/generation/types.ts', 'export type Input = any')).some(m => m.ruleId === '@typescript-eslint/no-explicit-any'))
})
