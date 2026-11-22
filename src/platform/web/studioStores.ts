export const studioStores = ['studioProjects', 'studioAssets', 'studioVersions', 'studioShots'] as const
export type StudioStore = typeof studioStores[number]
export const studioMediaPrefix = 'studio-media-'
// The next lexicographic prefix bounds all studio aliases in the shared image store.
export const studioMediaEnd = 'studio-media.'

export function createStudioStores(db: IDBDatabase) {
  for (const name of studioStores) {
    const store = db.createObjectStore(name, { keyPath: 'id' })
    if (name === 'studioVersions') store.createIndex('assetNumber', ['assetId', 'number'], { unique: true })
    if (name === 'studioShots') store.createIndex('projectPosition', ['projectId', 'position'], { unique: true })
  }
}
