export type InterrogateAssistLayoutCanvas = 'single' | 'multi_panel' | 'collage'

export interface InterrogateAssistLayoutItem {
  label: 'character' | 'object' | 'text'
  caption: string
  bbox: [number, number, number, number]
  text?: string
}

export interface InterrogateAssistLayout {
  canvas: InterrogateAssistLayoutCanvas
  items: InterrogateAssistLayoutItem[]
}
