import type { ArtistStyleOption } from './artistStyles.ts'
import { CURATED_STYLE_OPTIONS } from './artistStyleCatalogCurated.ts'
import { FEATURE_STYLE_OPTIONS } from './artistStyleCatalogFeatures.ts'
import { ARTIST_STYLE_OFFICIAL_OPTIONS } from './artistStyleCatalogOfficial.ts'

export const ARTIST_STYLE_OPTIONS: readonly ArtistStyleOption[] = Object.freeze([
  {
    id: 'blue_archive_style',
    name: 'Blue Archive Style',
    cnName: '蔚蓝档案风格',
    waiTag: 'blue_archive_style',
    animaTag: 'blue archive style',
    description: '《蔚蓝档案》画风提示词',
    category: 'pure',
    verification: 'style',
    keywords: ['碧蓝档案', '蔚蓝档案', 'blue archive'],
  },
  ...CURATED_STYLE_OPTIONS,
  ...FEATURE_STYLE_OPTIONS,
  ...ARTIST_STYLE_OFFICIAL_OPTIONS,
])
