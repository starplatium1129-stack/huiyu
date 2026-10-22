import type { ArchiveIconName } from '../components/visual/icons/types.ts'

export interface ArtistComboPreset {
  id: string
  label: string
  icon?: ArchiveIconName
  artistIds: readonly string[]
  tagline: string
  mood: string
}

export const ARTIST_COMBO_PRESETS: readonly ArtistComboPreset[] = Object.freeze([
  { id: 'cinematic_pure', label: '电影通透感', icon: 'wideshot', artistIds: ['yoneyama_mai:1.15', 'kantoku:0.7'], tagline: '米山舞 × 监督', mood: '电影级流动光影与清透甜美五官' },
  { id: 'pure_galgame', label: '极致水灵少女', icon: 'flower', artistIds: ['hiten_(hitenkei):1.0', 'tiv:0.75', 'azuuru:0.6'], tagline: 'Hiten × Tiv × Azure', mood: '柔光日系空气感、清爽五官与水灵发丝' },
  { id: 'witch_journey', label: '空灵魔女旅行', icon: 'wand', artistIds: ['rella:1.1', 'azuuru:0.8'], tagline: 'Rella × Azure', mood: '清澈透明感、水润发丝与星夜旅行氛围' },
  { id: 'jelly_skin', label: '水润果冻肌', icon: 'spark', artistIds: ['momoco_haru:1.1', 'anmi:0.7'], tagline: 'も莫可 × Anmi', mood: '水灵眼眸与白皙水彩通透反光' },
  { id: 'starry_dream', label: '梦幻星夜微光', icon: 'moonlight', artistIds: ['rella:1.1', 'anmi:0.7'], tagline: 'Rella × Anmi', mood: '夜景星斑与清甜水润粉彩折射' },
  { id: 'noble_lady', label: '清冷贵气千金', icon: 'detail', artistIds: ['ask_(askzy):1.1', 'kantoku:0.7'], tagline: 'ASK × 监督', mood: '丝滑上色与克制的高级质感' },
  { id: 'pure_cel', label: '纯净青春赛璐珞', icon: 'goldenhour', artistIds: ['kantoku:1.1', 'ponkan8:0.75'], tagline: '监督 × ぽんかん⑧', mood: '清纯日系萌感与水彩赛璐珞质感' },
  { id: 'epic_fantasy', label: '奇幻史诗纵深', icon: 'wideshot', artistIds: ['swav:1.05', 'yoneyama_mai:0.7', 'hidulume:0.6'], tagline: 'SWAV × 米山舞 × ひづるめ', mood: '硬核纵深、魔法光照与大透视空气感' },
  { id: 'abyssal_melancholy', label: '深海秘境冷调', icon: 'moonlight', artistIds: ['alchemaniac:1.05', 'liduke:0.8'], tagline: 'Alchemaniac × Liduke', mood: '深海空灵冷调与温润柔和厚涂' },
  { id: 'ornate_japanese', label: '和风瑰丽水彩', icon: 'palette', artistIds: ['fuzichoco:1.05', 'nardack:0.75'], tagline: '藤choco × Nardack', mood: '繁复绚丽水彩层叠与宝石般细节' },
  { id: 'trend_cyber', label: '潮流先锋霓虹', icon: 'lightning', artistIds: ['lam_(ramdayo):1.15', 'mika_pikazo:0.75'], tagline: 'LAM × Mika Pikazo', mood: '极高饱和前卫撞色与锐利图形' },
  { id: 'dark_epic', label: '暗黑史诗油画', icon: 'flame', artistIds: ['so-bin:1.1', 'lack:0.8'], tagline: 'so-bin × lack', mood: '油画重度厚涂与史诗暗调氛围' },
])
