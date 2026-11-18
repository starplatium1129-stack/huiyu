import type { LightingId } from './sceneInference.ts'
import { normalizeKey } from './promptPrimitives.ts'

/** The first tag anchors the location. Every caption describes only this setting
 * and its primary light, so actions and characters can vary independently. */
export interface RandomSetting {
  tags: string[]
  lighting: LightingId
  actions: string[]
  caption: string
}

export const RANDOM_SETTINGS: RandomSetting[] = [
  { tags: ['library', 'bookshelf', 'desk'], lighting: 'window', actions: ['holding_book', 'sitting', 'leaning'],
    caption: 'Window light crosses the reading desk from the side and picks out the spines on the nearest library shelf. The shelves behind it recede into shade.' },
  { tags: ['classroom', 'desk', 'afternoon'], lighting: 'window', actions: ['on_desk', 'standing', 'sitting'],
    caption: 'Afternoon light from the classroom windows draws long rectangles across the desks, each row dimmer toward the back wall.' },
  { tags: ['music_room', 'piano'], lighting: 'window', actions: ['sitting', 'standing', 'leaning'],
    caption: 'A tall side window in the music room casts a narrow reflection along the piano lid and lights the keys below.' },
  { tags: ['cafe', 'rain', 'couch'], lighting: 'window', actions: ['holding_cup', 'sitting_on_sofa', 'sitting'],
    caption: 'Rain beads on the cafe window beside the couch. Gray light through the glass traces the piping along its cushions.' },
  { tags: ['living_room', 'couch', 'bookshelf'], lighting: 'lantern', actions: ['sitting_on_sofa', 'holding_book', 'holding_cup'],
    caption: 'A low reading lamp beside the living-room couch throws a warm pool of light across the cushions. The bookshelves on the far wall are just visible beyond it.' },
  { tags: ['bedroom', 'bed', 'night'], lighting: 'moon', actions: ['on_bed', 'sitting', 'stretching'],
    caption: 'Moonlight slips between the bedroom curtains and falls across the near edge of the bed, catching the ridges of the folded sheet.' },
  { tags: ['greenhouse', 'flower', 'rain'], lighting: 'overcast', actions: ['walking', 'leaning', 'standing'],
    caption: 'The rain-streaked greenhouse roof diffuses the light overhead. Flower heads along the nearest bench stand out against the damp rows beyond.' },
  { tags: ['shrine', 'stone_stairs', 'lantern'], lighting: 'lantern', actions: ['holding_broom', 'standing', 'walking'],
    caption: 'Lanterns beside the shrine steps cast warm light across the stone treads. The upper landing fades into shadow.' },
  { tags: ['festival', 'lantern', 'night'], lighting: 'lantern', actions: ['walking', 'holding_food', 'waving'],
    caption: 'Paper lanterns hang low over the night festival stalls. The closest lantern lights the counter from above while the others dwindle down the lane.' },
  { tags: ['beach', 'ocean', 'sunset'], lighting: 'golden', actions: ['walking', 'standing', 'stretching'],
    caption: 'The setting sun skims across the ocean and leaves a streak of amber on the wet sand between the foreground and the surf.' },
  { tags: ['beach', 'ocean', 'night_sky'], lighting: 'moon', actions: ['stargazing', 'walking', 'sitting'],
    caption: 'Beneath the open night sky, moonlight breaks into silver flecks along the surf. A thin line of foam marks the edge of the dark beach.' },
  { tags: ['park', 'autumn_leaves', 'sunset'], lighting: 'golden', actions: ['walking', 'sitting', 'standing'],
    caption: 'Low sun shines across the park path, lighting the curled edges of fallen autumn leaves and stretching their shadows over the gravel.' },
  { tags: ['bus_stop', 'rain', 'street'], lighting: 'overcast', actions: ['standing', 'sitting', 'leaning'],
    caption: 'Cloud light filters under the bus shelter. Rain stipples the street beyond its dry strip of pavement.' },
  { tags: ['school_rooftop', 'telescope', 'starry_sky'], lighting: 'moon', actions: ['stargazing', 'looking_up', 'standing'],
    caption: 'Moonlight glances off the telescope on the school rooftop. Beyond its dark tube a handful of bright stars show above the parapet.' },
  { tags: ['bridge', 'cityscape', 'sunset'], lighting: 'golden', actions: ['walking', 'leaning', 'standing'],
    caption: 'The low sun catches the bridge railing from the side. Beyond its repeating posts the city skyline settles into haze.' },
  { tags: ['train_interior', 'city_lights', 'night'], lighting: 'lantern', actions: ['sitting', 'standing', 'holding_book'],
    caption: 'Warm overhead lamps pick out the seat backs inside the train. Beyond the dark windows, distant city lights stretch into short streaks.' },
  { tags: ['kitchen', 'steam', 'morning'], lighting: 'window', actions: ['holding_cup', 'standing', 'leaning'],
    caption: 'Early light comes through the kitchen window at counter height. Steam from a pot catches the light against a row of dark cupboards.' },
  { tags: ['art_studio', 'desk', 'flower'], lighting: 'window', actions: ['sitting', 'leaning', 'standing'],
    caption: 'A vase casts a long shadow over the studio drawing desk. Light from the high window picks out the flower petals and the grain of the paper below.' },
  { tags: ['street', 'vending_machine', 'night'], lighting: 'back', actions: ['standing', 'walking', 'looking_up'],
    caption: 'A vending machine lights the night street from behind the subject. Its bright rows of buttons reflect in the pavement while the shop fronts beyond fall into shadow.' },
  { tags: ['park', 'snow', 'overcast'], lighting: 'overcast', actions: ['walking', 'standing', 'waving'],
    caption: 'Cloud light settles evenly over a snow-covered park bench. Dark branches cross the path behind it, and footprints give the snow a shallow relief.' },
  { tags: ['bedroom', 'bed', 'rain'], lighting: 'window', actions: ['on_bed', 'holding_book', 'sitting'],
    caption: 'Rain blurs the bedroom window. The cool light brushes the folds on the near side of the quilt and barely reaches the headboard.' },
  { tags: ['shrine', 'stone_stairs', 'cherry_blossoms'], lighting: 'golden', actions: ['walking', 'standing', 'holding_broom'],
    caption: 'The low sun strikes the shrine steps from one side, catching the cherry blossoms on the branches overhead and the fallen petals between the stones.' },
]

export function matchingRandomSetting(tags: readonly string[], lighting: string | null | undefined) {
  const keys = new Set(tags.map(normalizeKey))
  return RANDOM_SETTINGS.find(setting => setting.lighting === lighting && setting.tags.every(tag => keys.has(tag)))
}

// Krea needs a sentence for the visible action as well as the spatial relationships.
// Subject-neutral wording also works for unbound drawings and group compositions.
const activity: Readonly<Record<string, string>> = {
  holding_book: 'The reader holds a book.', holding_cup: 'The subject cradles a cup.',
  holding_broom: 'The subject grips a broom handle.', holding_food: 'The subject holds a portion of food.',
  sitting: 'The subject is seated.', standing: 'The subject stands upright.', leaning: 'The subject leans to one side.',
  walking: 'The subject is mid-stride.', stretching: 'The subject pauses to stretch.',
  waving: 'One hand is raised in a wave.', stargazing: 'The subject gazes up at the stars.',
  looking_up: 'The subject looks up.', sitting_on_sofa: 'The subject sits on the couch.',
  on_bed: 'The subject is on the bed.', on_desk: 'The subject is perched on a desk.',
}

export function kreaSetting(setting: RandomSetting, manual: readonly string[]) {
  const action = manual.map(normalizeKey).find(key => setting.actions.includes(key) && activity[key])
  const described = new Set(setting.tags)
  if (action) described.add(action)
  return { prose: [action && activity[action], setting.caption].filter(Boolean).join(' '),
    remaining: (tag: string) => !described.has(normalizeKey(tag)) }
}
