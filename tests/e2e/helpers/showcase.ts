import type { Page } from '@playwright/test'

/** Neutral local references for reading/layout tests, independent of private media. */
export async function installSceneReferences(page: Page) {
  const ids = ['sc001', 'sc002', 'sc003', 'sc004', 'sc006', 'sc007', 'sc011', 'sc013', 'sc069', 'sc215']
  await page.route('**/scene-showcase/manifest.json', route => route.fulfill({ json: {
    entries: ids.map(id => ({ id, title: `中性布局夹具 ${id}`, char: 'nene', type: 'scene', rating: 'All', width: 832, height: 1216 })),
  } }))
  await page.route(/\/scene-showcase\/(images|thumbs)\/sc\d+\.jpg/, route => route.fulfill({
    contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="832" height="1216"><rect width="832" height="1216" fill="#746687"/><circle cx="416" cy="360" r="140" fill="#d5e1e2"/></svg>',
  }))
}

// Synthetic browser artwork; never a published or audited sample.
export async function installShowcaseFixture(page: Page, options: { failFirst?: boolean } = {}) {
  let requests = 0
  await page.route('**/scene-showcase/manifest.json', route => {
    requests++
    if (options.failFirst && requests === 1) return route.fulfill({ status: 503, json: {} })
    return route.fulfill({ json: { entries: [
      { id: 'sc001', title: '测试场景', char: 'nene', type: 'scene', rating: 'All', width: 832, height: 1216 },
      // 第二条不带尺寸：真实发布集合的 manifest 就是这样，页面必须退回原图自然比例。
      { id: 'pc_raiden_shogun_raiden_shogun_tenshukaku', title: '雷电将军 · 天守阁内廷', char: 'raiden_shogun', displayName: '雷电将军', type: 'popular', rating: 'All' },
    ] } })
  })
  await page.route(/\/scene-showcase\/(images|thumbs)\/[^?]+/, route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="832" height="1216"><rect width="832" height="1216" fill="#746687"/><text x="80" y="160" fill="white" font-size="48">UI TEST FIXTURE</text></svg>',
  }))
  return { requests: () => requests }
}
