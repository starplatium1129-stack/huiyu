import type { ArtistStyleOption } from './artistStyles.ts'
import { CURATED_STYLE_OPTIONS } from './artistStyleCatalogCurated.ts'
import { FEATURE_STYLE_OPTIONS } from './artistStyleCatalogFeatures.ts'
import { ARTIST_STYLE_OFFICIAL_OPTIONS } from './artistStyleCatalogOfficial.ts'

export const ARTIST_STYLE_OPTIONS: readonly ArtistStyleOption[] = Object.freeze([
  ...CURATED_STYLE_OPTIONS,
  ...FEATURE_STYLE_OPTIONS,
  ...ARTIST_STYLE_OFFICIAL_OPTIONS,
])
