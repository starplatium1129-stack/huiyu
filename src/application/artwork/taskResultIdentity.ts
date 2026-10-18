/** One received output keeps its artwork identity across every save entry point. */
export const taskArtworkId = (taskId: string, index: number) => `task-${taskId}-${index}`
