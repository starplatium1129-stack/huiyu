import { expect, type Locator } from '@playwright/test'

/**
 * StudioSelect 的 e2e 选择动作（2026-09-22）。
 *
 * 背景：全站原生 `<select>` 已换成 `src/components/ui/StudioSelect.vue` 的 Reka 下拉，
 * 组件不再渲染任何原生 select（`apple-hig-accessibility` / `companion-focus` 要求
 * 指定容器内原生控件数为 0）。Playwright 的 `selectOption()` 只作用于原生 select
 * 元素，因此这里统一改成「点开 trigger → 点选项」。
 *
 * 定位约定仍然是可访问名（`label` prop 或 `<label for>`），与迁移前一致；
 * 选项上带 `data-value`（等于原生 `<option value>`），所以仍可按值选择，
 * 不必回头查显示文案。
 */

/** 点开下拉并返回弹层；调用方若需要自行筛选项用它。 */
export async function openStudioSelect(trigger: Locator): Promise<Locator> {
  await trigger.click()
  const popup = trigger.page().locator('.studio-select-content')
  await expect(popup).toBeVisible()
  return popup
}

/** 按 option value 选择（等价原来的 selectOption('value')）。 */
export async function pickStudioOptionByValue(trigger: Locator, value: string): Promise<void> {
  const popup = await openStudioSelect(trigger)
  // 值标记挂在选项文本上（SelectItem 外层还有 CollectionItem，属性透传不保证），
  // 这里点回选项本体，保证走的是 Reka 的 pointerup 选中路径。
  await popup.locator(`.studio-select-item:has([data-value="${value}"])`).click()
  await expect(popup).toBeHidden()
}

/** 按显示文案选择（等价原来的 selectOption({ label })）。 */
export async function pickStudioOptionByLabel(trigger: Locator, label: string | RegExp): Promise<void> {
  const popup = await openStudioSelect(trigger)
  await popup.getByRole('option', { name: label, exact: typeof label === 'string' }).click()
  await expect(popup).toBeHidden()
}

/**
 * 断言当前选中值（等价原来的 `toHaveValue('v')`）：读 trigger 上的 data-value，不依赖显示文案。
 * 值本身不确定时（例如模型 id 随引擎变化）可传正则，保持原 `toHaveValue(/anima/)` 的口径。
 */
export async function expectStudioSelectValue(
  trigger: Locator,
  value: string | RegExp,
  options: { timeout?: number } = {},
): Promise<void> {
  await expect(trigger).toHaveAttribute('data-value', value, options)
}

/**
 * 读出全部选项（等价原来对 `<option>` 的读取：文案、value、顺序）。
 * 读完按 Escape 收起，调用方接着用 pickStudioOptionByValue 选择。
 */
export async function readStudioOptions(trigger: Locator): Promise<{ label: string; value: string }[]> {
  const popup = await openStudioSelect(trigger)
  const options = await popup.locator('.studio-select-item').evaluateAll(nodes => nodes.map(node => ({
    label: (node.textContent ?? '').trim(),
    value: node.querySelector('[data-value]')?.getAttribute('data-value') ?? '',
  })))
  await trigger.page().keyboard.press('Escape')
  await expect(popup).toBeHidden()
  return options
}
