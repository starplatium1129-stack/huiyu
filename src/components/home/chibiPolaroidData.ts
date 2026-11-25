import { CHARACTERS } from '@/config/characters'
import neneNightThumb from '../../../assets/chibi/nene-night.webp'
import neneNightFull from '../../../assets/chibi/nene-night-full.webp'
import natsumeCoffeeThumb from '../../../assets/chibi/natsume-coffee.webp'
import natsumeCoffeeFull from '../../../assets/chibi/natsume-coffee-full.webp'

export interface ChibiPolaroidEntry {
  id: 'nene' | 'natsume'
  name: string
  subtitle: string
  stamp: string
  noteCode: string
  tilt: string
  thumb: string
  full: string
  alt: string
  caption: string
  dialogue: string
  jpQuote?: string
}

export const CHIBI_POLAROID_ENTRIES: readonly ChibiPolaroidEntry[] = [
  {
    id: 'nene',
    name: CHARACTERS.nene?.name || '绫地宁宁',
    subtitle: '深夜星光手帖',
    stamp: 'NENE',
    noteCode: '深夜小记',
    tilt: '-2deg',
    thumb: neneNightThumb,
    full: neneNightFull,
    alt: '绫地宁宁在星光夜色里托腮微笑的 Q 版拍立得',
    caption: '「今晚的星星好多，再聊五分钟再睡吧。」',
    dialogue: '「……还没困吗？窗外刚好有星光呢。如果不急着继续画的话，在这里稍微歇一会儿，聊点今天的小事也好呀。」',
    jpQuote: CHARACTERS.nene?.officialQuote,
  },
  {
    id: 'natsume',
    name: CHARACTERS.natsume?.name || '四季夏目',
    subtitle: '打烊吧台手帖',
    stamp: 'NATSUME',
    noteCode: '吧台小记',
    tilt: '2deg',
    thumb: natsumeCoffeeThumb,
    full: natsumeCoffeeFull,
    alt: '四季夏目在咖啡吧台端着热杯专注挑选的 Q 版拍立得',
    caption: '「打烊后的特调手冲，只留给熟客一杯。」',
    dialogue: '「忙到现在才想起喘口气？真是拿你没办法……喏，刚温好的黑咖啡。喝完这杯，再去画下一张也不迟。」',
    jpQuote: CHARACTERS.natsume?.officialQuote,
  },
]
