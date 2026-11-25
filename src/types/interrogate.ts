export type InterrogateAssistLayoutCanvas = 'single' | 'multi_panel' | 'collage'

export interface InterrogateAssistLayoutItem {
  label: 'character' | 'object' | 'text'
  caption: string
  bbox: [number, number, number, number]
  clothing?: string
  pose?: string
  text?: string
}

export interface InterrogateAssistLayout {
  canvas: InterrogateAssistLayoutCanvas
  scene?: string
  items: InterrogateAssistLayoutItem[]
}
