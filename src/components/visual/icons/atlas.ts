import type { ArchiveIconDef } from './types'

// Original HUIYU line emblems for the relationship atlas; not official franchise logos.
export const atlasDefs = {
  'atlas-dragon': { paths: ['M4 4 8 8 5 10 9 12 7 15 12 21 17 15 15 12 19 10 16 8 20 4', 'M8 3 10 7 12 9 14 7 16 3', 'M10 14 12 16 14 14 M12 16V20'] },
  'atlas-sun': { paths: ['M12 2V5 M4 5 6 7 M20 5 18 7 M2 12H5 M19 12H22', 'M7 14A6 6 0 1 1 17 14', 'M4 18Q8 14 12 18T20 18 M6 21H18'] },
  'atlas-halo': { paths: ['M5 5C5 1 19 1 19 5S5 9 5 5Z', 'M12 9V22 M8 13H16', 'M4 10 7 14V19 M20 10 17 14V19 M7 19 12 22 17 19'] },
  'atlas-lyre': { paths: ['M5 3Q12 7 19 3L17 15Q12 23 7 15Z', 'M8 6 9 17 M12 7V19 M16 6 15 17', 'M7 21H17 M4 3Q2 6 6 8 M20 3Q22 6 18 8'] },
  'atlas-wolf': { paths: ['M3 3 10 8H14L21 3 19 15 12 22 5 15Z', 'M6 11 10 14 M18 11 14 14 M10 17 12 19 14 17', 'M8 6 6 3 M16 6 18 3'] },
  'atlas-leaf': { paths: ['M12 22V11 M12 17C2 18 2 8 3 4 10 6 13 9 12 17Z', 'M12 13C11 6 16 2 21 2 22 8 19 13 12 13Z', 'M6 9 12 17 M17 6 12 13'] },
  'atlas-pine': { paths: ['M12 2 5 10H9L3 17H9L5 21H19L15 17H21L15 10H19Z', 'M12 16V23'] },
  'atlas-city': { paths: ['M3 21H21 M4 21V10H9V21 M9 21V5H15V21 M15 21V10H20V21', 'M12 2V5 M7 13V15 M12 9V11 M12 15V17 M17 13V15'] },
  'atlas-gate': { paths: ['M2 4Q12 7 22 4 M3 9H21 M7 6 6 22 M17 6 18 22', 'M12 6V9 M8 14H16'] },
  'atlas-bird': { paths: ['M12 20C9 15 2 14 2 6L9 12 8 4 12 9 16 4 15 12 22 6C22 14 15 15 12 20Z', 'M10 20 12 23 14 20'] },
  'atlas-tower': { paths: ['M3 21 12 2 21 21Z', 'M8 18V10H10V12H14V10H16V18 M6 21V18H18V21', 'M11 18V15H13V18'] },
  'atlas-crown': { paths: ['M3 6 7 12 12 3 17 12 21 6 19 18H5Z', 'M6 22H18 M8 16H16 M12 10V13'] },
  'atlas-wave': { paths: ['M12 3C16 8 19 9 19 14A7 7 0 0 1 5 14C5 9 8 8 12 3Z', 'M4 14Q8 10 12 14T20 14 M6 18Q9 15 12 18T18 18'] },
  'atlas-spire': { paths: ['M12 2 15 13 21 8 18 21H6L3 8 9 13Z', 'M12 9V21 M7 17 12 21 17 17'] },
  'atlas-orbit': { paths: ['M6 3H18L12 21Z', 'M3 15C-1 9 22 3 22 9S5 21 3 15Z', 'M10 2H14 M11 22H13'] },
  'atlas-lily': { paths: ['M12 2C6 8 8 12 12 16 16 12 18 8 12 2Z', 'M12 16C12 7 2 6 3 11S9 18 12 16C15 18 20 15 21 11S12 7 12 16Z', 'M7 18H17 M12 16V22 M9 22H15'] },
  'atlas-wings': { paths: ['M12 18 8 8 3 2 4 10 1 7 4 15 9 19', 'M12 18 16 8 21 2 20 10 23 7 20 15 15 19', 'M9 4 12 9 15 4 M10 20 12 23 14 20'] },
  'atlas-cat': { paths: ['M4 3 10 7H14L20 3 19 16 12 21 5 16Z', 'M7 12H9 M15 12H17 M10 16 12 18 14 16', 'M1 14 5 15 M19 15 23 14'] },
  'atlas-horns': { paths: ['M9 11C-2 13 1 0 6 3 2 6 6 9 10 8 M15 11C26 13 23 0 18 3 22 6 18 9 14 8', 'M8 10 9 18 12 22 15 18 16 10 M10 15H14'] },
} satisfies Record<string, ArchiveIconDef>
export type AtlasEmblemName = keyof typeof atlasDefs
