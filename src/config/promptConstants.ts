// 导演台：情绪、镜头、光照、构图、色彩情调静态定义

import type { ArchiveIconName } from '../components/visual/icons/types.ts'

export interface ChoiceDef { id: string; iconName: ArchiveIconName; name: string; en: string; prompt?: string }
export interface ColorMoodDef { id: string; iconName: ArchiveIconName; name: string; en: string; colors: string[]; desc: string; prompt: string }
/** 带单色矢量图标的选项（ArchiveIcon 名），替代彩色 Emoji 的 UI 展示 */
export interface IconChoiceDef extends ChoiceDef {}

export const EMOTION: IconChoiceDef[] = [
  { id:'happy',   iconName:'happy',   name:'开心',  en:'Happy',     prompt:'happy' },
  { id:'shy',     iconName:'shy',     name:'害羞',  en:'Shy',       prompt:'shy, blush' },
  { id:'miss',    iconName:'miss',    name:'思念',  en:'Missing',   prompt:'wistful' },
  { id:'expect',  iconName:'expect',  name:'期待',  en:'Expectant', prompt:'excited, sparkling eyes' },
  { id:'nervous', iconName:'nervous', name:'紧张',  en:'Nervous',   prompt:'nervous, blush' },
  { id:'gentle',  iconName:'gentle',  name:'温柔',  en:'Gentle',    prompt:'light smile' },
  { id:'moved',   iconName:'moved',   name:'感动',  en:'Moved',     prompt:'teary_eyes' },
  { id:'sad',     iconName:'sad',     name:'失落',  en:'Sad',       prompt:'sad' },
  { id:'calm',    iconName:'calm',    name:'平静',  en:'Calm',      prompt:'calm' },
  { id:'joyful',  iconName:'joyful',  name:'幸福',  en:'Joyful',    prompt:'in_love, blush' },
  { id:'relaxed', iconName:'relaxed', name:'放松',  en:'Relaxed',   prompt:'relaxed' },
  { id:'serious', iconName:'serious', name:'认真',  en:'Serious',   prompt:'serious' },
  { id:'love',    iconName:'love',    name:'恋爱',  en:'In Love',   prompt:'in_love, blush' },
  { id:'sleepy',  iconName:'sleepy',  name:'困倦',  en:'Sleepy',    prompt:'sleepy' },
  { id:'spoiled', iconName:'spoiled', name:'撒娇',  en:'Spoiled',   prompt:'pout' },
  { id:'wronged', iconName:'wronged', name:'委屈',  en:'Wronged',   prompt:'teary_eyes, pout' },
]

export const SHOT: ChoiceDef[] = [
  { id:'close',  iconName:'closeup',   name:'近景特写', en:'Close-up',     prompt:'close-up' },
  { id:'medium', iconName:'midshot',   name:'半身中景', en:'Medium Shot',  prompt:'medium shot' },
  { id:'wide',   iconName:'wideshot',  name:'全身远景', en:'Wide Shot',    prompt:'wide shot' },
  { id:'pov',    iconName:'pov',       name:'第一人称', en:'POV',          prompt:'pov' },
  { id:'low',    iconName:'lowangle',  name:'仰视',    en:'Low Angle',    prompt:'low angle' },
  { id:'high',   iconName:'highangle', name:'俯视',    en:'High Angle',   prompt:'high angle' },
  { id:'side',   iconName:'sideview',  name:'侧面',    en:'Side View',    prompt:'side view' },
  { id:'turn',   iconName:'turnshot',  name:'回头',    en:'Turn Back',    prompt:'looking back' },
  { id:'over',   iconName:'selfie',    name:'自拍',    en:'Selfie',       prompt:'selfie' },
  { id:'detail', iconName:'detail',    name:'局部特写', en:'Detail',       prompt:'extreme close-up' },
]

export const LIGHTING: ChoiceDef[] = [
  { id:'golden',   iconName:'goldenhour',  name:'夕阳 Golden Hour', en:'Golden Hour',  prompt:'golden hour' },
  { id:'window',   iconName:'windowlight', name:'窗光 Window Light', en:'Window Light', prompt:'window light' },
  { id:'back',     iconName:'backlight',   name:'逆光 Backlight',   en:'Backlight',    prompt:'backlighting' },
  { id:'moon',     iconName:'moonlight',   name:'月光 Moonlight',   en:'Moonlight',    prompt:'moonlight' },
  { id:'lantern',  iconName:'lantern',     name:'夜灯 Lantern',     en:'Lantern',      prompt:'lantern' },
  { id:'overcast', iconName:'overcast',    name:'阴天柔光 Overcast', en:'Overcast',    prompt:'overcast' },
]

export const COMPOSITION: ChoiceDef[] = [
  { id:'center',     iconName:'centercomp', name:'居中',    en:'Center',      prompt:'centered composition' },
  { id:'rule3',      iconName:'rule3',      name:'三分法',  en:'Rule of 3',   prompt:'rule of thirds' },
  { id:'left',       iconName:'leftcomp',   name:'左构图',  en:'Left',        prompt:'off-center composition' },
  { id:'right',      iconName:'rightcomp',  name:'右构图',  en:'Right',       prompt:'off-center composition' },
  { id:'foreground', iconName:'foreground', name:'前景遮挡', en:'Foreground',  prompt:'blurry foreground' },
  { id:'frame',      iconName:'framecomp',  name:'框架构图', en:'Frame',       prompt:'framed' },
  { id:'bywindow',   iconName:'bywindow',   name:'窗边',    en:'By Window',   prompt:'by window' },
]

export const COLOR_MOODS: ColorMoodDef[] = [
  { id:'joy',     iconName:'sun',      name:'快乐', en:'Joy',     prompt:'yellow theme, warm tones',        desc:'暖黄/浅橙/明亮', colors:['#FFE082','#FFD54F','#FFB300','#FF8F00','#FFF8E1'] },
  { id:'love',    iconName:'love',     name:'恋爱', en:'Love',    prompt:'pink theme, warm light',          desc:'夕阳/粉色/暖光', colors:['#F8BBD0','#F06292','#EC407A','#AD1457','#FFF0F5'] },
  { id:'calm',    iconName:'leaf',     name:'平静', en:'Calm',    prompt:'green theme, soft tones, window light', desc:'淡绿/青绿/奶白', colors:['#C8E6C9','#81C784','#4CAF50','#2E7D32','#F1F8E9'] },
  { id:'sad',     iconName:'rain',     name:'忧伤', en:'Sad',     prompt:'blue theme, cool tones',          desc:'蓝色/灰蓝/冷调', colors:['#BBDEFB','#64B5F6','#1E88E5','#0D47A1','#E3F2FD'] },
  { id:'tension', iconName:'moonlight', name:'神秘', en:'Mystery', prompt:'purple theme, blue tones',        desc:'紫蓝/深紫/冷调', colors:['#E1BEE7','#BA68C8','#8E24AA','#4A148C','#F3E5F5'] },
  { id:'warmth',  iconName:'lantern',  name:'温馨', en:'Warmth',  prompt:'orange theme, candlelight',       desc:'暖橙/橘红/米黄', colors:['#FFE0B2','#FFB74D','#F57C00','#E65100','#FFF3E0'] },
]

export interface SceneThemeDef { id: string; label: string; iconName: ArchiveIconName; cat: string[] }

export const SCENE_THEMES: SceneThemeDef[] = [
  { id:'all',      label:'全部',    iconName:'spark',     cat:[] },
  { id:'romance',  label:'恋爱',    iconName:'love',      cat:['恋爱'] },
  { id:'daily',    label:'日常',    iconName:'coffee',    cat:['日常'] },
  { id:'intimate', label:'亲密',    iconName:'moonlight', cat:['亲密','R15'] },
  { id:'school',   label:'校园',    iconName:'cap',       cat:['校园'] },
  { id:'travel',   label:'旅行',    iconName:'plane',     cat:['旅行'] },
  { id:'festival', label:'节日',    iconName:'flower',    cat:['祭典・节日'] },
  { id:'story',    label:'剧情',    iconName:'play',      cat:['战斗','Active Sync'] },
  { id:'fanwork',  label:'同人',    iconName:'spark',     cat:['同人'] },
]
