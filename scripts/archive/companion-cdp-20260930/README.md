# 退役陪伴探针的使用边界

整理日期：2026-10-09。此页随退役源码保留，防止误用，不记录新的验收结果。

这四份源文件从 `scripts/maintenance/` 原样移动并保留 Git 跟踪，供历史审阅和可逆恢复；不是支持中的命令，也不应直接运行。未删除测试、改变孤儿脚本门禁或扩展豁免。

- `cdp-interact.ts`：硬编码连接 127.0.0.1:9222，按旧 `.companion-char-switch` 按钮切换角色；当前界面已用 `CompanionCharacterPicker`，旧按钮选择器不再对应模板。修改 UI 隐藏状态、点击和角色切换均有副作用。
- `cdp-shot.ts`：按已移除的 `#live2dHost` ID 读取状态，截图目标写死为 Administrator 的 Windows 桌面，不能作为可复用截图入口。
- `cdp-taps.ts`：固定舞台比例连续点击并修改 UI 隐藏状态，只打印提示，不校验命中区域、预期响应或闪烁；没有自动回归断言。
- `cdp-verify.ts`：沿用失效的 `#live2dHost` ID，修改 UI 隐藏状态，只打印 DOM，没有其注释所称的截图或通过/失败断言。

这些探针均从已存在的调试浏览器里按 URL 子串选取最后一个 `/companion` 页面，没有隔离上下文或目标身份确认；未找到页面时还会以成功状态返回。现行宿主为 `ChatCharacterStage.vue` 的 `.live2d-host`，不能把旧脚本输出作为现在的功能验收。

需要新诊断时，应先查 `docs/workflow.md` 与现行 `tests/e2e/companion-focus.spec.ts`、`tests/e2e/studio-live2d.spec.ts` 的明确断言和环境要求，按授权在隔离夹具或指定设备验收。不得启用这些旧探针绕过浏览器/设备限制，也不自动开启远程调试。
