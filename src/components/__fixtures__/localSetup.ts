import { mount } from '@vue/test-utils'
import LocalSetupPanel from '../LocalSetupPanel.vue'
import type { LocalSetupResponse } from '../../../types/local-setup'

export function complete(): LocalSetupResponse {
  const snapshot: LocalSetupResponse = { ok: true, checkedAt: 1_791_083_000_000,
    workspace: { path: 'D:\\AI', state: 'present' },
    comfy: { path: 'D:\\AI\\ComfyUI', installation: 'present', layout: 'portable', host: 'http://127.0.0.1:8188', connection: 'online' },
    models: ['anima-miaomiao-v1.6', 'qwen-encoder', 'qwen-vae'].map(id => ({ id, label: id, path: `D:\\AI\\ComfyUI\\models\\${id}`, state: 'present', bytes: 10, required: true, preparation: { url: 'https://huggingface.co/circlestone-labs/Anima/resolve/' + 'a'.repeat(40) + '/model.safetensors', modelCardUrl: 'https://huggingface.co/circlestone-labs/Anima', licenseUrl: 'https://huggingface.co/circlestone-labs/Anima/blob/' + 'a'.repeat(40) + '/LICENSE.md', upstreamLicenseUrl: null, revision: 'a'.repeat(40), expectedBytes: 10, sha256: 'b'.repeat(64) } })),
    nodes: { state: 'checked', required: ['ImageSharpenKJ'], missing: [] },
    hardware: { state: 'unknown', devices: [], ramBytes: null } }
  for(const id of ['L_NENE_V21_ANIMA','L_NAT_V21_ANIMA']) snapshot.models.push({
    ...snapshot.models[0],id,kind:'lora',required:false,path:snapshot.models[0].path.replace('anima-miaomiao-v1.6',id),
  })
  for(const id of ['runtime-comfy-nvidia','runtime-kjnodes','runtime-anima-teacache','runtime-llama-cuda','runtime-llama-cudart']) snapshot.models.push({
    ...snapshot.models[0],id,kind:'runtime',required:false,path:snapshot.models[0].path.replace('anima-miaomiao-v1.6',id),
  })
  return snapshot
}
export function deferred() {
  let resolve!: (value: LocalSetupResponse) => void
  const promise = new Promise<LocalSetupResponse>(finish => { resolve = finish })
  return { promise, resolve }
}
export function render(realSettings = false) {
  return mount(LocalSetupPanel, { global: { directives: { 'content-motion': {} }, stubs: { ArchiveIcon: true, Teleport: true, RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
    CompanionWorkspaceSettings: realSettings ? false : { name: 'CompanionWorkspaceSettings', props: ['open', 'modelValue', 'saving', 'error'], emits: ['save', 'close', 'update:modelValue'], template: '<div />' } } } })
}
