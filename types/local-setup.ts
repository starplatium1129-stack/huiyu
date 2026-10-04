export type LocalSetupFileState = 'present' | 'missing' | 'unknown'

export interface LocalSetupModelSource {
  url: string
  modelCardUrl: string
  licenseUrl: string
  upstreamLicenseUrl: string | null
  revision: string
  expectedBytes: number
  sha256: string
}

export interface LocalSetupModel {
  id: string
  label: string
  path: string
  state: LocalSetupFileState
  bytes: number | null
  required: boolean
  preparation: LocalSetupModelSource | null
}

/** 只读快照；文件存在、节点注册和硬件上报均不代表真实出图能力。 */
export interface LocalSetupResponse {
  ok: true
  checkedAt: number
  workspace: { path: string; state: LocalSetupFileState }
  comfy: {
    path: string
    installation: LocalSetupFileState
    layout: 'venv' | 'external-venv' | 'portable' | 'unrecognized'
    host: string
    connection: 'online' | 'offline' | 'unknown'
  }
  models: LocalSetupModel[]
  nodes: { state: 'checked' | 'unknown'; required: string[]; missing: string[] }
  hardware: {
    state: 'reported' | 'unknown'
    devices: Array<{ name: string; type: string; vramBytes: number | null }>
    ramBytes: number | null
  }
}
