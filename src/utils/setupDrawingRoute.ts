export type SetupDrawingFamily = 'anima' | 'krea2' | 'moss-image' | 'qwen-image'

export function firstDrawingRoute(modelId: string, family: SetupDrawingFamily) {
  const engine = family === 'moss-image' ? 'moss' : family === 'qwen-image' ? 'qwen' : undefined
  return { path: '/prompt-builder', query: { preparedModel: modelId, firstDraw: '1', engine } }
}
