export type Json = unknown

export function scene(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: id, ...extra }
}

export function response(value: Json): Response {
  return { ok: true, status: 200, json: async () => structuredClone(value) } as Response
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

export function fullRoutes(curation: Record<string, unknown> = {}) {
  return {
    'scenes-shared.json': [scene('sc001')],
    'scenes-nene.json': [scene('sc002')],
    'scenes-natsume.json': [scene('sc003')],
    'curation.json': curation,
    'characters.json': [{ id: 'char-1', name: 'Nene' }],
    'loras.json': [], 'tags.json': [], 'presets.json': [],
    'popular-characters.json': { characters: [] },
    'scene-blueprints.json': { blueprints: [] },
  }
}

export function revisionData(file: string, revision: string): Json {
  if (file === 'scenes-shared.json') return [scene('sc001', { title: `${revision}-shared` })]
  if (file === 'scenes-nene.json') return [scene('sc002', { title: `${revision}-nene` })]
  if (file === 'scenes-natsume.json') return [scene('sc003', { title: `${revision}-natsume` })]
  if (file === 'scenes-core.json') return [scene('sc004', { title: `${revision}-core` })]
  if (file === 'curation.json') return { revision }
  if (file === 'scenes-index.json') return { version: 1, total: 3 }
  if (file === 'characters.json') return [{ id: 'char-1', name: revision }]
  if (file === 'popular-characters.json') return { characters: [] }
  if (file === 'scene-blueprints.json') return {
    blueprints: [{
      id: 'bp-1', title: 'Blueprint', category: 'daily', description: 'A fixture blueprint',
      location: 'room', action: 'sit', timeOfDay: 'day', lighting: 'soft', camera: 'portrait',
      mood: 'calm', sceneTags: [], promptProse: 'A fixture scene', promptTokens: ['fixture'],
      negativeTokens: [], recommendedSize: '832x1216', adult: false,
    }],
  }
  return []
}
