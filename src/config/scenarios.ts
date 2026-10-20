// 剧本模式数据：ScenarioView 展示，PromptBuilderView 消费 ?scenario= 深链。
// 抽出来是为了避免视图之间互相 import；两处共用同一份数据与替换逻辑。

export type ScenarioCharacter = 'nene' | 'natsume'
export type ScenarioResolution = keyof typeof SCENARIO_RES_MAP

export interface ScenarioAct {
  n: string
  title: string
  en: string
  desc: string
  emotion: string
  res: ScenarioResolution
  neg: string
  prompt: string
}

export interface Scenario {
  outfitProse: string
  id: string
  icon: string
  iconName: 'cherry' | 'rain' | 'flower' | 'book'
  name: string
  en: string
  desc: string
  acts: ScenarioAct[]
}

export const SCENARIO_RES_MAP = {
  'Square':    { dim:'1024×1024', vram:'~10GB', reason:'方形·头像/特写/通用' },
  'Half-body': { dim:'832×1216',  vram:'~10GB', reason:'竖版半身·肖像感·内心独白' },
  'Full CG':   { dim:'1216×832',  vram:'~10GB', reason:'横版全身·场景为主·故事感★★★' },
  'Wide CG':   { dim:'1344×768',  vram:'~12GB', reason:'超宽画幅·风景/电影感/留白' },
  'Tall':      { dim:'768×1344',  vram:'~12GB', reason:'竖版插画·人物主体/海报感' },
  'Close-up':  { dim:'832×1216',  vram:'~10GB', reason:'近景特写·表情/情绪/亲密感' },
  'Portrait':  { dim:'832×1216',  vram:'~10GB', reason:'半身肖像·人物聚焦·柔美感' },
  'Mobile':    { dim:'768×1280',  vram:'~8GB',  reason:'手机竖屏壁纸' },
} as const

export const SCENARIO_CHARACTERS = ['nene', 'natsume'] as const

const SCENARIO_CHAR_TRAITS: Record<ScenarioCharacter, string> = {
  nene: 'white_hair, very_long_hair, low_twintails, purple_eyes, ahoge, hair_ribbon',
  natsume: 'black_hair, long_hair, yellow_eyes, mole_under_eye, hairclip',
}
const SCENARIO_CHAR_NAME: Record<ScenarioCharacter, string> = {
  nene: 'ayachi_nene',
  natsume: 'shiki_natsume',
}

/** 把模板里的 {{char}}/{{traits}} 替换成指定角色的词条 */
export function substituteScenarioPrompt(tpl: string, char: ScenarioCharacter): string {
  return tpl.split('\n').map(line => {
    let next = line.replace(/\{\{char\}\}/g, SCENARIO_CHAR_NAME[char]).replace(/\{\{traits\}\}/g, SCENARIO_CHAR_TRAITS[char])
    if (char === 'nene' && /school uniform/i.test(next)) next = next.replace(/school uniform/i, 'nene_school_uniform, school uniform')
    return next
  }).join('\n')
}

export const SCENARIOS: Scenario[] = [
  { id:'promise', icon:'cherry', iconName:'cherry', name:'放学后的约定', en:'After-School Promise', desc:'放学以后，她一直在校门口等你。花瓣落在肩上，她没有说，只是笑了起来。',
    outfitProse:'wearing a school uniform',
    acts:[
      { n:'01', title:'空·教室', en:'Empty Classroom', desc:'夕阳从窗户照进来，教室里已经没有人了。', emotion:'期待', res:'Half-body', neg:'night, snow, autumn leaves',
        prompt:'masterpiece, best quality, very aesthetic, absurdres\n1girl, solo, {{char}}, {{traits}}\nschool uniform\nclassroom, window, afternoon, sunlight streaming, dust motes\ngentle smile, soft eyes, looking through window, expectant\nclose-up, upper body\ncentered composition, by window, soft focus\nwindow light, soft afternoon glow, warm, quiet atmosphere\nbeautiful detailed eyes, depth of field' },
      { n:'02', title:'走廊', en:'School Hallway', desc:'她抱着书，走过长长的走廊。脚步声回响。', emotion:'紧张', res:'Half-body', neg:'night, darkness, sunny, bright sunlight, outdoor',
        prompt:'masterpiece, best quality, very aesthetic, absurdres\n1girl, solo, {{char}}, {{traits}}\nschool uniform\nschool hallway, long corridor, tiled floor, windows on one side\nnervous, walking, looking ahead, gentle\nmedium shot, walking away, from behind\nleft composition, leading lines, perspective depth\nafternoon light, soft glow through windows, quiet\nbeautiful detailed eyes, depth of field, echo atmosphere' },
      { n:'03', title:'校门口', en:'School Gate', desc:'她站在校门口，背着书包，望着道路远方。', emotion:'期待', res:'Full CG', neg:'night, snow, autumn leaves, indoor',
        prompt:'masterpiece, best quality, very aesthetic, absurdres\n1girl, solo, {{char}}, {{traits}}\nschool uniform, backpack\nschool gate, road stretching, sakura trees, golden hour sky\nstanding, looking afar, expectant, gentle posture\nwide shot, full body, distant\nrule of thirds, by school gate, depth\ngolden hour, warm light, backlit, soft shadows\nhair blowing, petals floating, depth of field' },
      { n:'04', title:'回眸', en:'The Turn', desc:'她看见你，终于露出了笑容。樱花落在肩上。', emotion:'温柔', res:'Half-body', neg:'night, darkness, snow, rain',
        prompt:'masterpiece, best quality, very aesthetic, absurdres\n1girl, solo, {{char}}, {{traits}}\nschool uniform, pleated skirt\nschool gate, cherry blossoms in bloom, petals floating\ngentle smile, soft eyes, blush, looking at viewer\nmedium shot, looking back, over shoulder\nrule of thirds, by school gate, depth\ngolden hour, backlit, soft shadows, warm atmosphere\nbeautiful detailed eyes, depth of field' },
    ]
  },
  { id:'rainy', icon:'rain', iconName:'rain', name:'雨天的共伞', en:'Sharing an Umbrella', desc:'突然下起雨。两个人挤在一把伞下。肩膀贴着肩膀。沉默比语言多。',
    outfitProse:'wearing a school uniform',
    acts:[
      { n:'01', title:'雨落', en:'Rain Falls', desc:'天空变暗。雨点打在柏油路上。她没有伞。', emotion:'失落', res:'Wide CG', neg:'sunny, bright lighting, day, summer, cherry blossoms',
        prompt:'masterpiece, best quality, very aesthetic, absurdres\n1girl, solo, {{char}}, {{traits}}\nschool uniform, no umbrella, wet\nrainy street, wet road, puddle reflections, grey sky\nsad, distant gaze, walking alone\nwide shot, full body, small in frame\nrule of thirds, leading lines, depth\novercast, cool tones, soft diffused light, rainy atmosphere\nbeautiful detailed eyes, depth of field, melancholic' },
      { n:'02', title:'递伞', en:'The Umbrella', desc:'你递过伞。她愣了一下，接过去，指尖微凉。', emotion:'羞涩', res:'Half-body', neg:'sunny, bright lighting, day, summer, dramatic',
        prompt:'masterpiece, best quality, very aesthetic, absurdres\n1girl, solo, {{char}}, {{traits}}\nschool uniform, holding umbrella, rain in background\ngentle surprise, soft expression, shy, slight blush, looking at viewer\nmedium shot, upper body, intimate\ncentered, foreground umbrella edge\novercast, cool color tones, warm interaction, soft\nbeautiful detailed eyes, depth of field' },
      { n:'03', title:'共伞', en:'Under One Umbrella', desc:'两个人挤在一把伞下。没有人说话。雨声很大。', emotion:'亲密', res:'Close-up', neg:'sunny, bright lighting, day, summer, outdoor',
        prompt:'masterpiece, best quality, very aesthetic, absurdres\n1girl, solo, {{char}}, {{traits}}\nunder umbrella, rain, close to viewer\nshy, looking away, slight blush, intimate\nclose-up, face and umbrella edge, intimate distance\ncentered, foreground framing\novercast, rainy atmosphere, soft lighting, cool tones\nbeautiful detailed eyes, beautiful detailed hair, depth of field' },
    ]
  },
  { id:'sakura', icon:'flower', iconName:'flower', name:'樱花树下的初见', en:'Under the Sakura', desc:'春天的公园，樱花盛开。她站在树下等人，花瓣落在发梢。',
    outfitProse:'wearing a school uniform',
    acts:[
      { n:'01', title:'等待', en:'Waiting', desc:'她站在樱花树下，不时看一眼路的尽头。', emotion:'期待', res:'Full CG', neg:'night, snow, autumn leaves, winter, rain',
        prompt:'masterpiece, best quality, very aesthetic, absurdres\n1girl, solo, {{char}}, {{traits}}\nschool uniform, spring coat\npark, sakura tree in full bloom, petals floating, afternoon\nexpectant, looking at path, gentle, hopeful\nwide shot, full body, among sakura\nrule of thirds, layered foreground petals, depth\nsoft spring light, warm pink glow, petals in air, dreamlike\nhair blowing, beautiful detailed eyes, depth of field' },
      { n:'02', title:'落樱', en:'Falling Petals', desc:'一阵风来，花瓣如雪落下。她伸手去接。', emotion:'开心', res:'Half-body', neg:'night, snow, autumn leaves, indoor',
        prompt:'masterpiece, best quality, very aesthetic, absurdres\n1girl, solo, {{char}}, {{traits}}\nschool uniform, cherry blossoms falling\npark, sakura tree, petals in air, spring afternoon\nhappy, looking up, reaching for petals, playful\nmedium shot, upper body, near\ncentered, foreground petals framing\nsoft spring light, pink glow, petals, airy\nhair blowing, beautiful detailed eyes, depth of field' },
      { n:'03', title:'重逢', en:'Reunion', desc:'她终于看见你，笑了。花瓣停在发梢。', emotion:'幸福', res:'Half-body', neg:'night, snow, rain, autumn leaves',
        prompt:'masterpiece, best quality, very aesthetic, absurdres\n1girl, solo, {{char}}, {{traits}}\nschool uniform, sakura in hair\npark, sakura tree, petals on ground, spring\ngentle smile, eyes lighting up, blush, looking at viewer\nmedium shot, upper body, intimate\nrule of thirds, foreground sakura branches\nsoft spring light, warm glow, petals falling, romantic\nbeautiful detailed eyes, depth of field' },
    ]
  },
]

export function findScenario(id: string): Scenario | null {
  return SCENARIOS.find(scenario => scenario.id === id) ?? null
}
