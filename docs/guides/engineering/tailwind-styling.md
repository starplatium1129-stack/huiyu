# Tailwind CSS 样式维护

前端采用 **Tailwind CSS 4.3.3**（通过 Vite 插件构建），仅用于 `src/` 内的 Vue 应用（`css/docs.css` 静态文档、首帧占位与原生渲染器不共用）。

---

## 1. 核心配置与变量映射

- **唯一入口**：`src/assets/css/tailwind.css`（由 `src/main.ts` 引入），仅扫描应用 Vue/TS 与入口 HTML。
- **固定前缀 `tw:`**：所有工具类加 `tw:` 前缀（如 `tw:flex tw:items-center tw:gap-s-2`），避免冲突。
- **禁用 Preflight 与 `@layer`**：由现有 `design-system.css` 承担 reset 与全局材质；utilities 不单独放低优先级 layer，以免被通配 reset 覆盖。
- **主题映射**：`@theme inline` 只映射已有变量，深浅主题及角色强调色仍由运行时与 CSS 变量控制，不在 Tailwind 重复定义色板。

| 设计意图 | 推荐写法 | 对应令牌 |
| --- | --- | --- |
| 主 / 次 / 禁用文字 | `tw:text-primary` / `tw:text-secondary` / `tw:text-disabled` | 禁用态禁止用 `opacity` |
| 表面与边框 | `tw:bg-surface tw:border-soft` | 主题表面变量 |
| 项目间距 | `tw:gap-s-2 tw:p-s-4` | `--s-2` / `--s-4`（随根字号缩放，勿直接拿 `gap-3` 等同 `12px`） |
| 字号与行高 | `tw:text-body tw:leading-body` | 两者独立配置 |
| 圆角 | `tw:rounded-md` | `--r-md` |
| 运行时动态尺寸 | 写入 CSS 自定义属性，工具类读取变量 | 严禁拼接 `tw:bg-${color}` 等动态类名 |

---

## 2. 模板与组件样式规范

- **Utilities vs `@apply`**：单元素常规布局直接写 utilities；复用控件、动态状态、复杂后代选择器在独立 CSS 或 scoped `<style>` 中通过 `@reference` 引入 `tailwind.css` 并使用 `@apply`（禁止重复导入完整 Tailwind 输出，也不要在同一属性保留旧 CSS 兜底）。
- **独立组件样式 (`src/assets/css/components/`)**：Select、媒体控件、聊天设置等完整样式通过 `<style scoped src>` / `<style src>` 引入，防止被 `@source` 扫描生成重复全局样式。
- **保留原生 CSS 场景**：`background`/`font` shorthand、渐变、遮罩、关键帧、特殊材质与原生窗口定位继续用 CSS（注意 shorthand 与 longhand 在同一 `@apply` 中的排序覆盖）。
- **动画与兼容**：高频动画仅使用 `transform`/`opacity`；保留 `vite.config.ts` 中的 `@apply` `@property` 兼容前置 hook。

---

## 3. 浏览器目标与校验

- **最低支持版本**：Chrome/Edge `111`、Safari `16.4`、Firefox `128`（实际支持范围见 `package.json`）。
- **交付核对**：按修改范围执行构建检查与对比度/颜色/动画检查，并在双主题下实测；状态详见 [项目状态](../../project-status.md)。
