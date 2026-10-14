import type { VideoDefaults, VideoShotSize } from '@/api/videoApi'

/**
 * 分镜编辑器的镜头草稿（编辑态）。提交时由 useShotBatchMachine 组装为
 * 服务端载荷（prompt 前置身份锚点、seed 解析、参考图挂载）。
 */
export interface ShotDraft {
  prompt: string
  dialogue: string
  shotSize: VideoShotSize | ''
  camera: VideoDefaults['camera']
  motion: VideoDefaults['motion']
  duration: 3 | 5 | 10 | 15
  seedText: string
  imageName: string
  imageUrl: string
  /**
   * 首帧在 IndexedDB 的图片 id（2026-09-06 体验报告 F1/F4）：草稿持久化与
   * 导入失败重试的耐久凭据——服务端受控文件名（imageName）会随任务清理，
   * blob URL（imageUrl）随页面卸载失效，只有它能跨页/刷新找回原图。
   */
  imageId?: string
  /** Durable import receipt; remains unchanged when the first frame is edited. */
  importSourceImageId?: string
  /** Stable acknowledgement of a pending scenario act, independent of edits. */
  importSourceActId?: string
  /** 出场角色：'' 无 / '1' 角色1 / '2' 角色2 / '12' 角色1+2 / 'all' 全部角色（对应参考卡）。 */
  cast: '' | '1' | '2' | '3' | '4' | '12' | 'all' | string
  /** 剧本引擎派生的首帧出图提示词（蓝图散文+景别构图句）；「一键首帧」消费。 */
  firstFramePrompt?: string
}
