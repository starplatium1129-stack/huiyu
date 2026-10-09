# Tailwind 样式维护

前端使用 Tailwind CSS 4.3.3 与 Vite 插件。适用范围为 `src/` 的 Vue 应用和 Web/desktop 两个构建；静态文档站 `css/docs.css`、首帧占位及外部原生渲染器有各自的职责，不共用组件工具类。

## 入口与主题

- 唯一工具类入口：`src/assets/css/tailwind.css`，由 `src/main.ts` 引入。仅扫描应用 Vue/TS 和入口 HTML，不扫描数据、测试产物、资产或依赖目录。
- 所有工具类使用 `tw:` 前缀，例如 `tw:flex tw:items-center tw:gap-s-2`，避免与语义类、脚本和测试选择器碰撞。
- 不启用 Preflight。现有 `design-system.css` 负责 reset、主题令牌和全局材质，避免引入第二套控件重置。
- Utilities 不放入 CSS layer：现有 reset 和 scoped CSS 均未分层。将 utilities 单独放入低优先级层会使间距被通配 reset 清零。共享材质/状态和 scoped 选择器仍按原有 specificity 与源码顺序生效。
- `@theme inline` 只映射现有变量，深浅主题及角色强调色由原有运行时控制，包含局部角色主题和 Reka portal。不要在 Tailwind 再定义一份配色。
- 场景卡、色彩卡和查看器的 CSS 从实际消费者导入，不再进入每个页面的入口包。
- 当前官方 Vite 插件未暴露 polyfill 配置。`vite.config.ts` 中的窄前置 hook 使用同一官方编译器处理组件 `@apply`，保留 `@property` 回退，省去目标浏览器已支持的 `color-mix` 重复回退。默认插件继续负责全局 utilities 的扫描/HMR。上游支持配置后移除该 hook，不能通过删除必要兼容逻辑压缩体积。

| 意图 | 写法 |
| --- | --- |
| 主/次/禁用文字 | `tw:text-primary` / `tw:text-secondary` / `tw:text-disabled` |
| 表面和边框 | `tw:bg-surface tw:border-soft` |
| 项目间距 | `tw:gap-s-2 tw:p-s-4`，映射 `--s-2` / `--s-4` |
| 项目字号与行高 | `tw:text-body tw:leading-body`，两者独立 |
| 圆角 | `tw:rounded-md`，映射 `--r-md` |
| 运行时尺寸 | 数据写 CSS 自定义属性，工具类读取变量 |

项目根字号随用户偏好变化，`--s-*` 为既有设计尺度。不能将旧 `12px` 直接替换成默认 `gap-3` 并假定像素相等。优先语义令牌，确有不同尺寸再保留精确值。

## 模板与组件规则

单元素常规布局优先直接写 utilities。复用控件的完整外观、跨组件覆盖、动态状态、复杂后代选择器和媒体条件保留语义选择器，使用 `@apply` 共享同一套工具类；不得同时保留同一属性的旧声明作为兜底。

使用 `@apply` 的独立 CSS 或 Vue style 块必须 `@reference` 到 `tailwind.css`，不能再次导入完整 Tailwind 输出。现有导出组件与自动化依赖的语义 class 是行为契约，迁移样式不删除这些 hook。

Select、媒体控件及聊天设置等完整组件样式放在 `src/assets/css/components/`，用原有 `<style scoped src>` / `<style src>` 方式引入。这样 `@source` 扫描 Vue 模板时不会把只供 `@apply` 展开的工具再次生成为全局样式。保持 scoped/global 属性和加载归属，不把局部样式加入入口。聊天归档、个人档案、长期记忆面板随用户打开时加载。

背景/字体 shorthand、动态网格、渐变、遮罩、关键帧、材质和原生窗口定位可保留必要 CSS。`background` 与 `background-color`、`font` 与 `font-size` 不等价。Tailwind 会对同一 `@apply` 的工具排序；存在 shorthand/longhand 或重复属性覆盖时保持分开的声明顺序。频繁动画仍只用 transform/opacity，豁免沿用原有审查规则。

不要动态拼接 `tw:bg-${color}` 一类不完整类名；使用完整候选映射，或将数据传入 CSS 变量。禁止通过任意值工具类绕过颜色令牌、字号/圆角预算或动画门禁。手绘图标继续使用 `ArchiveIcon`，禁用文字继续使用 `--text-disabled`。

## 浏览器与验收

最低版本为 Chrome/Edge 111、Safari 16.4、Firefox 128；Firefox 下限随本次 Tailwind 4 接入经用户确认调整。实际浏览器支持与设备验收分别报告。

按工作流分层验证。构建链变动跑全量门禁；样式变动继续跑颜色、对比度、字面量、动画检查，并在浏览器验收双主题和相关交互。门禁同时检查模板和 `@apply` 中的工具类，不能用 CSS 声明数量下降代替质量提升。包体预算保持原限额。

迁移范围、实测结果及环境限制见 [当前状态与验证边界](../../project-status.md)。
