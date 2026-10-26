import type { Component } from 'vue'

let promptWorkspaceImport: Promise<{ default: Component }> | null = null

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
