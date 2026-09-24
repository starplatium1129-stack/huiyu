import type { Page } from '@playwright/test'

/** Route-shell tests do not exercise the 5MB maintenance snapshot; keep them hermetic. */
export async function installSceneStateFixture(page: Page) {
  await page.route('**/api/maintenance/scenes-state', route => route.fulfill({
    json: {
      ok: true,
      version: 1,
      nextSceneId: 'sc1000',
      sceneCount: 0,
      retiredCount: 0,
      snapshot: { scenes: [], tags: [], curation: {}, blueprints: [] },
    },
  }))
}
