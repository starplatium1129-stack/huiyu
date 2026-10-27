import type { LocationQuery } from 'vue-router'

/** Carry the selected task and storyboard view back from environment setup. */
export function videoReturnLocation(query: LocationQuery) {
  return { path: '/video-studio', query: {
    ...(typeof query.videoJob === 'string' ? { job: query.videoJob } : {}),
    ...(query.videoMode === 'shots' ? { mode: 'shots' } : {}),
  } }
}
