import type { VideoDefaults, VideoMode } from '@/api/videoApi'
import type { ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'

export interface VideoPromptFields {
  setup: string
  action: string
  atmosphere: string
  ending: string
}

export interface VideoPromptEdit {
  prompt: string
  camera: VideoDefaults['camera']
  motion: VideoDefaults['motion']
}

interface VideoPromptPreset {
  id: string
  title: string
  icon: ArchiveIconName
  fields: Partial<VideoPromptFields>
  camera: VideoPromptEdit['camera']
  motion: VideoPromptEdit['motion']
}

// Original scene starters. The existing video pipelines add their own
// model-specific framing, reference instructions and continuity guidance.
export const videoPromptPresets: Record<VideoMode, readonly VideoPromptPreset[]> = {
  text: [
    {
      id: 'rain-platform', title: '雨站等车', icon: 'rain', camera: 'push', motion: 'natural',
      fields: {
        setup: '雨后的傍晚，一位撑着透明伞的旅人站在空旷的电车站台上。',
        action: '旅人稍稍举起伞，抬头望向轨道弯道。',
        atmosphere: '远处的车灯渐渐亮起，把暖色倒影拉长到潮湿的站台边缘。',
        ending: '旅人的目光停在车灯上，手仍扶着伞柄。',
      },
    },
    {
      id: 'window-letter', title: '窗边读信', icon: 'bywindow', camera: 'still', motion: 'natural',
      fields: {
        setup: '晨光照进安静的书房，一位读信人坐在窗边，手里摊着一封信。',
        action: '读到末尾时，读信人的指尖停在纸边，慢慢抬眼。',
        atmosphere: '窗帘轻轻鼓起，柔光滑过信纸的折痕。',
        ending: '读信人嘴角微微抬起，安静地看向窗外。',
      },
    },
    {
      id: 'lantern-street', title: '灯笼街口', icon: 'lantern', camera: 'pull', motion: 'subtle',
      fields: {
        setup: '蓝调时刻，小巷檐下悬着一盏暖色灯笼，石板路延伸向安静的街口。',
        action: '灯笼被风带得轻轻摇摆，柔和的光影沿墙面缓慢往复。',
        ending: '灯笼回到近乎静止，巷口与远处屋檐留在同一个画面里。',
      },
    },
    {
      id: 'bookstore-meeting', title: '书店相遇', icon: 'book', camera: 'still', motion: 'natural',
      fields: {
        setup: '两位读者站在旧书店同一排书架前，中间隔着一本半抽出的精装书。',
        action: '两人同时伸手，在即将碰到书脊时停住，抬眼看向对方。',
        ending: '其中一位收回手，让另一位把书从架上拿下来。',
      },
    },
  ],
  image: [
    {
      id: 'living-portrait', title: '立绘微动', icon: 'closeup', camera: 'still', motion: 'subtle',
      fields: {
        action: '人物自然呼吸，轻轻眨一次眼，视线保持在原来的方向。',
        ending: '眨眼后恢复首帧的神情和姿势，构图保持稳定。',
      },
    },
    {
      id: 'look-back', title: '回眸慢推', icon: 'turnshot', camera: 'push', motion: 'natural',
      fields: {
        action: '人物先用余光看向画外，再慢慢转头，肩膀略微跟随。',
        ending: '目光落在镜头旁，转头的动作自然停住。',
      },
    },
    {
      id: 'breeze', title: '微风拂过', icon: 'sideview', camera: 'still', motion: 'subtle',
      fields: {
        action: '人物保持首帧姿势，发梢先被轻风吹起，随后发丝和衣缘轻轻摆动。',
        ending: '风势减弱，发梢与衣缘各自落回原来的位置。',
      },
    },
    {
      id: 'walking', title: '侧向跟拍', icon: 'midshot', camera: 'pan', motion: 'natural',
      fields: {
        action: '人物沿身体朝向迈出两步，镜头平移跟上，保持主体在画面中的位置。',
        atmosphere: '近处景物缓慢划过画面，远景移动得更慢。',
        ending: '人物放慢脚步，镜头也随之减速。',
      },
    },
  ],
  'first-last-frame': [
    {
      id: 'pose-transition', title: '姿态渐变', icon: 'turnshot', camera: 'still', motion: 'natural',
      fields: {
        action: '人物从首帧的姿势开始，先轻微转移重心，再让身体和视线顺着尾帧方向转过去。',
        ending: '在尾帧的姿势和视线上停住，服装、发型和背景位置保持连贯。',
      },
    },
    {
      id: 'framing-transition', title: '远景推进', icon: 'wideshot', camera: 'push', motion: 'subtle',
      fields: {
        action: '从首帧的较远景别缓慢向主体推进，保持移动方向和视线连续。',
        atmosphere: '随着距离缩短，画面边缘的背景逐渐让出空间。',
        ending: '临近尾帧时逐渐减速，停在尾帧的景别与构图上。',
      },
    },
    {
      id: 'light-transition', title: '灯光渐亮', icon: 'windowlight', camera: 'still', motion: 'subtle',
      fields: {
        action: '保持首帧的机位，人物只做细微的呼吸动作。',
        atmosphere: '亮处从光源附近缓慢扩开，墙面和衣料上的阴影同步变淡。',
        ending: '光线稳定在尾帧的亮度与色温，保留相同的空间关系。',
      },
    },
    {
      id: 'arc-transition', title: '绕到另一侧', icon: 'pov', camera: 'orbit', motion: 'subtle',
      fields: {
        action: '从首帧机位沿一条平缓弧线绕向主体另一侧，让近处景物随视角变化自然错开。',
        ending: '沿原方向减速，最后与尾帧的视角和取景对齐。',
      },
    },
  ],
}

export const videoPromptGuidance: Record<VideoMode, string> = {
  text: '先交代谁在什么地方，再安排一个清楚的动作和收尾。',
  image: '首帧负责交代长相和构图。描述画面接下来怎么动。',
  'first-last-frame': '选好首尾两张图，写清姿态、机位或光线怎么从第一张变到第二张。',
}

export function blankVideoPromptFields(): VideoPromptFields {
  return { setup: '', action: '', atmosphere: '', ending: '' }
}

export function assembleVideoPrompt(mode: VideoMode, fields: VideoPromptFields): string {
  return [mode === 'text' ? fields.setup : '', fields.action, fields.atmosphere, fields.ending]
    .map(part => part.trim())
    .filter(Boolean)
    .join('\n')
}
