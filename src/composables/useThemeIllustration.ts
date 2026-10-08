import { computed } from 'vue'
import { useDesktopPreferences } from './useDesktopInteraction'
import scene from '@/assets/illustrations/terraria-scene.webp'
import draw from '@/assets/illustrations/terraria-draw.webp'
import collection from '@/assets/illustrations/terraria-collection.webp'
import character from '@/assets/illustrations/terraria-character.webp'
import palette from '@/assets/illustrations/terraria-palette.webp'
import model from '@/assets/illustrations/terraria-model.webp'
import motion from '@/assets/illustrations/terraria-motion.webp'
import room from '@/assets/illustrations/terraria-room.webp'

const pixelIllustrations = { scene, draw, collection, character, palette, model, motion, room }

/** Theme-owned decorations only; catalog artwork and user images never pass through this map. */
export function useThemeIllustration(original: string, subject: keyof typeof pixelIllustrations) {
  const { themeStyle } = useDesktopPreferences()
  return computed(() => themeStyle.value === 'terraria' ? pixelIllustrations[subject] : original)
}
