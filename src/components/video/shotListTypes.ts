import type { VideoDefaults, VideoShotSize } from '@/api/videoApi'
import type { FirstFrameRequest } from '@/types/firstFrameRequest'

/**
 * 分镜编辑器的镜头草稿（编辑态）。提交时由 useShotBatchMachine 组装为
 * 服务端载荷（prompt 前置身份锚点、seed 解析、参考图挂载）。
 */
export interface ShotDraft {
  storyOrigin?: import('@/types/storyOrigin').StoryOrigin
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
   * 首帧的耐久图片 ID：草稿持久化与导入重试据此找回原图。
   * 受控上传名（imageName）不作为恢复凭据；预览 URL（imageUrl）只属于当前页面。
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
  firstFrameRequest?: FirstFrameRequest
}
