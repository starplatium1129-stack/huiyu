import type { KeyframeTag } from './h3TagCompiler'

export const expressionTags: readonly KeyframeTag[] = [
  { id: 'smile', label: '浅笑', directive: 'A small closed-mouth smile with relaxed eyebrows and warm eye contact.' },
  { id: 'surprise', label: '惊讶', directive: 'Lift both brows slightly and part the lips, with the gaze fixed just beside the camera.' },
  { id: 'thoughtful', label: '若有所思', directive: 'Lower the gaze to one side, with slightly drawn brows and lips at rest.' },
  { id: 'hesitant', label: '有些迟疑', directive: 'Glance sideways with gently pressed lips and a faint flush across the cheeks.' },
  { id: 'determined', label: '下定决心', directive: 'Look squarely ahead with steady eyes, lowered brows and a firm mouth.' },
  { id: 'laugh', label: '笑出声', directive: 'A natural open laugh, with raised cheeks and lightly crinkled eyes.' },
  { id: 'pout', label: '闹别扭', directive: 'A slight pout and a sidelong glance, with one eyebrow gently drawn inward.' },
  { id: 'grief', label: '忍住眼泪', directive: 'Raise the inner eyebrows and hold a thin glint of tears along the lower lids.' },
]

export const poseTags: readonly KeyframeTag[] = [
  { id: 'three-quarter', label: '侧身 45°', directive: 'Turn the head and torso 45 degrees, with both eyes visible and both arms relaxed.' },
  { id: 'seated', label: '坐姿', directive: 'Sit upright on a neutral low seat with both feet supported and hands resting naturally in the lap.' },
  { id: 'turn', label: '转身回眸', directive: 'Show the body in a three-quarter back view while the character looks back over one shoulder.' },
  { id: 'walk', label: '迈步', directive: 'Capture a single walking step with one foot bearing weight and the opposite arm swinging gently forward.' },
  { id: 'reach', label: '伸手', directive: 'Reach forward with one relaxed open hand, keeping the other arm near the body and the torso balanced.' },
  { id: 'lean', label: '俯身', directive: 'Lean forward slightly from the hips, with softly bent knees and hands relaxed at the sides.' },
]

export const framingTags: readonly KeyframeTag[] = [
  { id: 'close', label: '特写', directive: 'Frame a close-up on the face and shoulders, keeping the eyes sharp and the background softly readable.' },
  { id: 'medium', label: '半身', directive: 'Frame a waist-up medium shot at eye level. Keep the near hand and upper garment in view.' },
  { id: 'wide', label: '全身', directive: 'Frame the full figure from head to feet with enough space to read the surroundings and floor contact.' },
  { id: 'look-back', label: '回眸', directive: 'Use a three-quarter medium shot as the character looks back over one shoulder toward the camera.' },
  { id: 'dialogue', label: '对话构图', directive: 'Frame a clear medium close-up, with the character facing slightly off-camera toward an unseen conversation partner.' },
  { id: 'backlight', label: '逆光剪影', directive: 'Frame a medium shot against the main light, with a defined rim on the hair and shoulders and enough bounce light to read the face and costume details.' },
]

export const settingTags: readonly KeyframeTag[] = [
  { id: 'window', label: '窗边午后', directive: 'Set the scene beside a tall window with warm afternoon light crossing a quiet room from camera left.' },
  { id: 'station', label: '雨夜车站', directive: 'Set the scene under a covered station platform at night, with cold rain beyond the canopy and a warm lamp reflected on the wet pavement.' },
  { id: 'cafe', label: '街角咖啡馆', directive: 'Set the scene in a quiet corner café with dark wood tables, a street-facing window and soft overcast daylight.' },
  { id: 'garden', label: '暮色庭院', directive: 'Set the scene on a stone path in a walled garden at dusk. Cool sky light reaches the path while a single warm lantern lights the near wall.' },
]

export const clothingParts: readonly KeyframeTag[] = [
  { id: 'shirt', label: '白衬衫', directive: 'a crisp white button-up shirt' },
  { id: 'cardigan', label: '针织开衫', directive: 'a soft cream knitted cardigan' },
  { id: 'skirt', label: '百褶裙', directive: 'a charcoal pleated skirt' },
  { id: 'trousers', label: '直筒裤', directive: 'high-waisted straight-leg trousers' },
  { id: 'trench', label: '风衣', directive: 'a belted beige trench coat' },
  { id: 'boots', label: '短靴', directive: 'dark leather ankle boots' },
  { id: 'bow', label: '丝带领结', directive: 'a narrow burgundy ribbon bow at the collar' },
]
