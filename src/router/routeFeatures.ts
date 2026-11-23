import type { Component } from 'vue'

let promptWorkspaceImport: Promise<{ default: Component }> | null = null
let drawingResourcePrefetch: Promise<void> | null = null

/** Share the drawing route's primary import between intent prefetch and the
 * mounted shell. A rejected transfer can be retried by AsyncPanel. */
export function loadPromptDrawingWorkspace(): Promise<{ default: Component }> {
  if (!promptWorkspaceImport) {
    const current = import('@/components/director/PromptDrawingWorkspace.vue')
      .catch(error => {
        if (promptWorkspaceImport === current) promptWorkspaceImport = null
        throw error
      })
    promptWorkspaceImport = current
  }
  return promptWorkspaceImport
}

/** Share the store-owned catalog reads between navigation intent and route entry. */
export function prefetchDrawingResources(): void {
  if (drawingResourcePrefetch) return
  const current = import('@/stores/sceneStore').then(async ({ useSceneStore }) => {
    const store = useSceneStore()
    await store.loadDrawingCatalog()
  })
  drawingResourcePrefetch = current
  void current.catch(error => {
    console.warn('[route-prefetch] /prompt-builder', error)
  }).finally(() => {
    if (drawingResourcePrefetch === current) drawingResourcePrefetch = null
  })
}
