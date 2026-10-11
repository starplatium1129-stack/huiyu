import type { LocalSetupModel, LocalSetupResponse } from '../../types/local-setup.ts'

/** Length checks intentionally do not claim SHA-256 or inference verification. */
export function modelPreparationState(model: LocalSetupModel): 'missing' | 'unknown' | 'size-mismatch' | 'bytes-match' {
  if (model.state === 'missing') return 'missing'
  if (model.bytes === null || !model.preparation) return 'unknown'
  if (model.bytes !== model.preparation.expectedBytes) return 'size-mismatch'
  return model.state === 'present' ? 'bytes-match' : 'unknown'
}

export function formatSetupBytes(value: number): string {
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${value.toLocaleString('zh-CN')} B`
}

/** Shared by the read-only guide and the final check after preparing drawing. */
export function drawingSetupReadiness(snapshot: LocalSetupResponse, modelId?: string) {
  const models = snapshot.models.filter(model => model.required)
  const modelsReady = models.length >= 3 && models.every(model => modelPreparationState(model) === 'bytes-match')
    && (!modelId || models.some(model => model.id === modelId))
  const nodesChecked = snapshot.nodes.state === 'checked' && snapshot.nodes.required.length > 0
  const steps = [
    { id: 'workspace', label: '1. 准备环境', ready: snapshot.workspace.state === 'present' && snapshot.comfy.installation === 'present', detail: snapshot.comfy.installation === 'present' ? '已识别环境目录；依赖与 GPU 仍需启动确认' : '选择工作区后，由绘遇下载并准备环境' },
    { id: 'files', label: '2. 配置模型', ready: modelsReady, detail: modelsReady ? '所选组合大小相符；下载时另做 SHA-256 校验' : '在下方选择模型，自动下载到对应目录' },
    { id: 'connection', label: '3. 启动服务', ready: snapshot.comfy.connection === 'online', detail: snapshot.comfy.connection === 'online' ? '服务已连接；请确认是当前环境' : '准备完成后启动绘图服务' },
    { id: 'nodes', label: '4. 开始生成', ready: snapshot.workspace.state === 'present' && snapshot.comfy.installation === 'present' && modelsReady && snapshot.comfy.connection === 'online' && nodesChecked && snapshot.nodes.missing.length === 0, detail: nodesChecked && snapshot.nodes.missing.length === 0 ? '节点已注册；第一张图仍需实际验证' : '连接后检查工作流节点，再进入画室' },
  ]
  const complete = steps.every(step => step.ready)
  const nextStep = !steps[0].ready || snapshot.comfy.installation !== 'present'
    ? '先选择 AI 工作区，再在下方选择模型并一键准备。已有服务可在手动管理中核对。'
    : !modelsReady ? '按来源、大小与精确路径补齐或核对所选模型组合；已有其他底模仍可按原配置使用。'
    : !steps[2].ready ? '用下方一键准备或控制室启动绘图服务，无需另开 ComfyUI 界面；外部管理的环境沿用原入口。'
    : !nodesChecked ? '节点注册信息尚未确认，请核对连接的 ComfyUI 服务后重新检查。'
    : !steps[3].ready ? `缺少工作流节点：${snapshot.nodes.missing.join('、')}。按下方说明检查扩展，重启 ComfyUI 后重新检查。`
    : '前往绘图画室选择角色和场景、检查提示词与参数。模型就绪的机器可继续生成一张全龄图片。'
  return { complete, steps, nextStep }
}
