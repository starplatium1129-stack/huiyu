import { expect, test } from '@playwright/test'
import type { ResourceAction, ResourceStatus, ResourceTask } from '../../src/types/resources'
import { GUEST_GUIDE_DISMISSED_KEY, THEME_KEY } from '../../src/utils/storageKeys'

test.use({ serviceWorkers: 'block' })

const initial = (): ResourceStatus => ({ ok: true, configured: true, managementEnabled: true, busy: false,
  mounted: true, current: { identity: 'a'.repeat(64), releaseId: 'portraits-v1', files: 3 }, canRollback: true,
  recoveryRequired: false, issue: null, task: null, releases: [
    { id: 'portraits', label: '本地资源测试包', identity: 'b'.repeat(64), kind: 'full', source: 'offline', downloaded: false },
    { id: 'hd', label: '高清资源测试包', identity: 'c'.repeat(64), kind: 'delta', source: 'http', downloaded: false },
  ] })
const task = (action: ResourceAction, state: ResourceTask['state']): ResourceTask => ({
  id: 'b5be9b25-3cb6-46e7-9b03-a78b6739e8f4', action, releaseId: 'portraits', resumeAction: null,
  state, phase: 'copy-progress', bytes: 2, total: 3, startedAt: 1, finishedAt: 0, error: null,
})

for (const theme of ['dark', 'light'] as const) {
  for (const width of [1440, 390]) {
    test(`resource library in control room ${theme} ${width}`, async ({ page }, testInfo) => {
      let state = initial()
      const writes: unknown[] = []
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 })
      await page.addInitScript(({ theme, themeKey, guideKey }) => {
        localStorage.setItem(themeKey, theme); localStorage.setItem(guideKey, '1')
      }, { theme, themeKey: THEME_KEY, guideKey: GUEST_GUIDE_DISMISSED_KEY })
      // All unhandled APIs are denied; these browser controls cannot reach real services.
      await page.route('**/api/**', route => route.fulfill({ status: 403, json: { ok: false, error: 'Isolated browser fixture' } }))
      await page.route('**/api/resources/**', route => {
        const request = route.request()
        if (request.method() === 'GET') return route.fulfill({ json: state })
        const body = request.postDataJSON() as { action?: ResourceAction; releaseId?: string }
        writes.push({ path: new URL(request.url()).pathname, body })
        if (request.url().endsWith('/cancel')) state = { ...state, busy: false, recoveryRequired: true, task: task('import', 'cancelled') }
        else if (body.action === 'recover') state = { ...state, busy: false, mounted: true, recoveryRequired: false, task: task('recover', 'completed') }
        else if (body.action === 'rollback') state = { ...state, busy: false, mounted: true,
          current: { identity: 'd'.repeat(64), releaseId: 'portraits-v0', files: 2 }, canRollback: false, task: task('rollback', 'completed') }
        else state = { ...state, busy: true, mounted: false, task: task(body.action!, 'running') }
        return route.fulfill({ status: 202, json: { ok: true, task: state.task } })
      })
      await page.goto('/control')
      const panel = page.locator('#control-library')
      await panel.scrollIntoViewIfNeeded()
      await expect(panel.getByRole('heading')).toContainText('让喜欢的画面')
      await expect(panel).toContainText('portraits-v1')
      expect(writes).toEqual([])
      const select = panel.getByRole('combobox', { name: '选择资源版本' })
      await select.selectOption('hd')
      await expect(panel.getByRole('button', { name: '安装所选版本' })).toBeDisabled()
      await expect(panel.getByRole('button', { name: '下载资源' })).toBeEnabled()
      expect(writes).toEqual([])
      await select.selectOption('portraits')
      const install = panel.getByRole('button', { name: '安装所选版本' })
      await install.focus(); await expect(install).toBeFocused()
      await panel.screenshot({ path: testInfo.outputPath(`resource-library-${theme}-${width}-ready.png`) })
      expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(width)
      await page.keyboard.press('Enter')
      await expect(panel.getByRole('progressbar')).toBeVisible()
      await expect(select).toBeDisabled()
      await panel.getByRole('button', { name: '取消操作' }).click()
      await expect(panel).toContainText('已取消，可继续恢复')
      await panel.screenshot({ path: testInfo.outputPath(`resource-library-${theme}-${width}-cancelled.png`) })
      await panel.getByRole('button', { name: '继续恢复' }).click()
      await expect(panel).toContainText('资源操作已完成')
      await expect(panel.getByRole('button', { name: '继续恢复' })).toHaveCount(0)
      await panel.getByRole('button', { name: '回退上一版本' }).click()
      await expect(panel).toContainText('portraits-v0')
      expect(writes).toEqual([
        { path: '/api/resources/tasks', body: { action: 'import', releaseId: 'portraits' } },
        { path: '/api/resources/tasks/b5be9b25-3cb6-46e7-9b03-a78b6739e8f4/cancel', body: {} },
        { path: '/api/resources/tasks', body: { action: 'recover' } },
        { path: '/api/resources/tasks', body: { action: 'rollback' } },
      ])
      expect(errors).toEqual([])
    })
  }
}
