/**
 * 环境感知问候（纯 TS，无 DOM）。
 *
 * 让角色感知"现在是几点、今天星期几"，在窗口重新可见或时间片切换时
 * 给出确定性台词。不调用 LLM、不联网；时间片与台词表在下方定义。
 */

export type EnvironmentTimeSlot =
  | 'late-night'   // 0:00 - 5:00  深夜
  | 'early-morning' // 5:00 - 9:00  清晨
  | 'morning'      // 9:00 - 12:00 上午
  | 'noon'         // 12:00 - 14:00 正午
  | 'afternoon'    // 14:00 - 18:00 下午
  | 'evening'      // 18:00 - 21:00 傍晚
  | 'night'        // 21:00 - 24:00 夜晚

function timeSlotOf(date: Date): EnvironmentTimeSlot {
  const hour = date.getHours()
  if (hour < 5) return 'late-night'
  if (hour < 9) return 'early-morning'
  if (hour < 12) return 'morning'
  if (hour < 14) return 'noon'
  if (hour < 18) return 'afternoon'
  if (hour < 21) return 'evening'
  return 'night'
}

function isWeekend(date: Date): boolean {
  const day = date.getDay()
  return day === 0 || day === 6
}

export interface EnvironmentGreeting {
  slot: EnvironmentTimeSlot
  weekend: boolean
  line: string
}

const SLOT_LABEL: Record<EnvironmentTimeSlot, string> = {
  'late-night': '深夜',
  'early-morning': '清晨',
  morning: '上午',
  noon: '正午',
  afternoon: '下午',
  evening: '傍晚',
  night: '夜晚',
}

function slotLabel(slot: EnvironmentTimeSlot): string {
  return SLOT_LABEL[slot]
}

/** 角色环境台词表：每时间片若干句，周末优先取 weekend 条目。 */
const ENVIRONMENT_LINES: Record<string, {
  weekday: Record<EnvironmentTimeSlot, string[]>
  weekend: Record<EnvironmentTimeSlot, string[]>
}> = {
  nene: {
    weekday: {
      'late-night': ['都这么晚啦……还不休息的话，我会担心的。', '夜深了。要是睡不着，我陪你聊聊天吧。'],
      'early-morning': ['早上好。……昨晚睡得好吗？', '清晨的阳光很不错呢。今天也一起加油吧。'],
      morning: ['上午好。有什么想做的事，都可以告诉我。', '今天上午的计划是什么？我帮你记着。'],
      noon: ['中午啦。记得好好吃饭，别又凑合。', '午休时间……要一起休息一会儿吗？'],
      afternoon: ['下午好。要不要喝点什么，歇一歇？', '下午的阳光有点懒洋洋的……你想做什么？'],
      evening: ['傍晚了呢。今天辛苦了，剩下的时间放松一下吧。', '夕阳很好看……要一起看看吗？'],
      night: ['晚上好。今天过得怎么样？', '夜晚最适合说悄悄话了。'],
    },
    weekend: {
      'late-night': ['周末的深夜……反而更睡不着了呢。', '明天不用早起，可以多聊一会儿。'],
      'early-morning': ['周末的早上，想睡懒觉也完全可以哦。', '今天不用赶时间……慢慢来。'],
      morning: ['周末上午好。今天有什么安排吗？', '难得的休息日，想怎么过呢？'],
      noon: ['周末的正午……要不要一起做点什么？', '难得休息，午饭想吃什么？'],
      afternoon: ['周末下午。想去哪里走走吗？', '休息日的午后最舒服了。'],
      evening: ['周末的傍晚，感觉时间都变慢了。', '周末晚上，做点喜欢的事吧。'],
      night: ['周末的夜晚，可以聊得晚一点。', '明天还有一天休息……今晚慢慢过。'],
    },
  },
  natsume: {
    weekday: {
      'late-night': ['这么晚还不睡？……咖啡我可不会给你续了。', '深夜了。工作是做不完的，去睡吧。'],
      'early-morning': ['早。今天也照常营业。', '早班时间……你先坐，咖啡马上好。'],
      morning: ['上午好。今天想喝什么？', '上午的店里很安静。'],
      noon: ['中午了。要吃饭还是继续干活？……别饿着。', '午间休息，店里就我们俩。'],
      afternoon: ['下午好。困的话，黑咖啡提神。', '下午的客人少了，正好清静。'],
      evening: ['傍晚了。今天辛苦，收工吧。', '这个点最适合放空。'],
      night: ['晚上好。打烊后的店，只为你开。', '夜里想聊什么？我听着。'],
    },
    weekend: {
      'late-night': ['周末深夜……难得清闲。', '明天休息，今晚可以晚点。'],
      'early-morning': ['周末早上好啊。睡到自然醒了？', '难得的休息日，别急着起。'],
      morning: ['周末上午。今天要出门吗？', '休息日想怎么安排？'],
      noon: ['周末中午，想吃点什么？', '难得的假日，别又对着屏幕。'],
      afternoon: ['周末下午。去晒晒太阳如何？', '下午茶时间到了。'],
      evening: ['周末傍晚，风挺舒服的。', '难得的休息日，做点喜欢的事吧。'],
      night: ['周末夜晚，可以放松了。', '明天还有一天，今晚慢慢来。'],
    },
  },
}

export function pickEnvironmentGreeting(
  characterId: string,
  date: Date,
  offset = 0,
): EnvironmentGreeting {
  const slot = timeSlotOf(date)
  const weekend = isWeekend(date)
  const table = ENVIRONMENT_LINES[characterId]
  if (!table) {
    return {
      slot,
      weekend,
      line: weekend ? '周末好。' : `${slotLabel(slot)}好。`,
    }
  }
  const lines = (weekend ? table.weekend : table.weekday)[slot]
  if (!lines || !lines.length) {
    return { slot, weekend, line: `${slotLabel(slot)}好。` }
  }
  const index = ((Math.abs(offset) % lines.length) + lines.length) % lines.length
  return { slot, weekend, line: lines[index] }
}
