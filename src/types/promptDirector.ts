export type DirectorControlKey = 'shot' | 'lighting' | 'composition' | 'colorMood'
export type DirectorControlSource = 'scene' | 'manual'
export type DirectorControlSources = Partial<Record<DirectorControlKey, DirectorControlSource>>
export type DirectorControlValues = Partial<Record<DirectorControlKey, string | null>>
