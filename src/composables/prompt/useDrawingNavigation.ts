import { inject, type InjectionKey, type Ref } from 'vue'

export type DrawingEngine = 'anima' | 'krea2' | 'moss' | 'qwen'
export interface DrawingNavigation {
  mode: Readonly<Ref<'moss' | 'qwen' | null>>
  selectEngine: (engine: DrawingEngine) => Promise<void>
  editImage: (url: string) => Promise<void>
  importing: Ref<boolean>
  openingEditor: Ref<boolean>
  error: Ref<string>
}
export const drawingNavigationKey: InjectionKey<DrawingNavigation> = Symbol('drawing-navigation')
export function useDrawingNavigation() {
  const navigation = inject(drawingNavigationKey)
  if (!navigation) throw new Error('绘图工具需在绘图画室内使用')
  return navigation
}
