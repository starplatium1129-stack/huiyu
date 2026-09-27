# 六项技术栈升级评估与实施

日期：2026-09-27。范围为六项评估及适用升级；全量 Rust 后端另开。先在独立 `stack-upgrades` worktree 实现，随后按用户要求合入 main 的 Tailwind 迁移提交 `efbc63a4`；没有安装到用户桌面。

## 决策与实现

| 项目 | 结果 |
| --- | --- |
| Vite | 6.4.3 → 8.3.1，Vue 插件 5.2.4 → 6.0.9。使用 Rolldown 的 `codeSplitting.groups` 与 `entriesAware` 保留路由懒加载，删除旧 `rollupOptions/manualChunks` 配置。预算不放宽。 |
| Vue | 3.5.13 → 3.5.43，同系列维护升级；锁文件同步 Vue 编译器及运行时。 |
| Node | 保留 24.18.0：`.nvmrc`、常规 CI、桌面 sidecar 已一致。22.18.0 CI 是显式 minimum-node 兼容任务，不是漂移；最低 engines 不改。 |
| 重任务 | SQLite 已有独立 Worker 和有界队列，无需重复迁移。WD14 的 ONNX Node binding 在 setImmediate 内同步推理，现改用专用 Worker，路由实例拥有客户端；单请求背压、超时、取消、迟到结果隔离、关闭回收。 |
| Tauri | Rust 核心 2.11.5 → 2.12.0，CLI 2.11.4 → 2.12.0，build 2.6.3 → 2.7.0；定向更新现有插件及其必要依赖，官方 NSIS 模板同步至 2.12.0。 |
| wgpu / Cubism / ONNX | ONNX Runtime Node 1.29.0 → 1.30.0。wgpu 保持 27 系列当前补丁（主库27.0.1/core27.0.3/hal27.0.4）；30跨代变更尚无本项目收益证据。Cubism Native 5-r.5 已为核对时稳定版本。 |

现有原型基准脚本直接导入 esbuild，过去依赖 Vite 的传递依赖。Vite 8 移除这条依赖后，补为直接开发依赖 esbuild 0.27.4；没有新增业务运行时工具。

WD14 取消意味着及时停止等待，不保证立即中断原生推理。旧 Worker 未退出时持续拒绝新任务，防止连续超时制造无界原生线程。Sharp 增加 32 Mi 像素、单边8192、处理5秒限制；输入/输出 Tensor 在 finally 释放，切换模型时释放旧 session。Worker 消息只传必要路径及推理选项。

## 隔离工作区验证记录

- 升级前构建通过；Vite 步骤16.21秒。升级后同工作区样本1.93秒，非统计基准，不代表端到端构建或模型加速。
- 原预算通过：入口静态闭包214.0 KiB / 390；最大路由闭包662.0 KiB / 680；最大路由JS138.5 KiB / 140。
- 完整 gate 已执行：Vitest 通过、unit 1170用例通过、contract 39文件通过、构建通过。check 初轮失败包括原有E2E登记遗漏、图片元素类型收窄缺失和参考素材缺失。
- 修正原有7个未登记E2E文件的lane，并为原有图片加载断言增加HTMLImageElement收窄；登记测试与TypeScript定向复验通过。
- 最终WD14隔离回归5/5通过，覆盖关闭期间其他服务继续清理、无上游兜底、取消/超时背压、跨线程配置投影及缺模型路径。真实推理没有被测试替身绕过后意外调用：路由替身已改到client工厂边界。
- check复验中前后端类型、ESLint、样式/对比度、数据构建等通过；原有native title数量为36，高于基线35，`test-native-controls`仍失败。此次没有修改Vue界面，未放宽该门禁。
- 浏览器：desktop-image-origin与浮层6项通过；tabs/tools和home/bookshelf双主题、宽窄屏8项通过，人工查看深浅主题桌面截图。
- studio-primitives的4项旧搜索测试失败：脚本要求可填写Combobox，但当前ShowcaseView已使用StudioSelect；该差异可由基线源码确认，未为迁就脚本改变产品控件。
- `cargo check --locked` 通过，使用已有Cubism SDK；没有安装新SDK。
- `prepare:tauri` 通过；隔离暂存网关健康检查通过，ONNX1.30原生模块加载通过，NSIS模板定向测试通过。

完整 gate **不记为通过**：参考图未随Git进入隔离工作区，真实素材检查失败，且原有native title基线检查仍失败。没有放宽基线、将索引改为pending或跳过素材检查来消除失败。

真实WD14权重推理、原生推理终止后的长期内存趋势、Tauri窗口/托盘/休眠的设备验收以及完整安装尚未执行。编译通过不代表这些验收通过。

## main 合并复验

- 保留Tailwind 4.3.3插件、自定义组件CSS编译和Firefox128目标；合入Rolldown分包并重新解析锁文件。Tailwind使用Lightning CSS1.32，Vite使用1.33，各自依赖由锁文件解析。
- 合并后构建及原包体预算通过：入口CSS98.0 KiB / 100，最大路由静态JS655.4 KiB / 680。
- 合并后浏览器20/20通过，覆盖深浅主题、宽窄屏、桌面图片来源、控件、浮层、聊天面板和工作台。main已有更新后的控件测试，因此隔离工作区原有4项控件脚本失败不再存在。
- 合并后完整gate执行5分30秒：Vitest、unit1170用例、contract39文件、构建通过；check失败不伪报PASS。最初的3项未合并索引状态已解决并重跑check子套件；剩余为参考素材缺失和既有native title36/35。未跑到的最后一项UX检查已定向补跑15条断言通过。
- 未提交的013 Rust迁移计划及其roadmap/索引修改不纳入本次升级提交。

## 上游依据

- [Vite 8迁移](https://vite.dev/guide/migration)
- [Tauri变更记录](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/CHANGELOG.md)
- [ONNX Runtime 1.30](https://github.com/microsoft/onnxruntime/releases/tag/v1.30.0)
- [wgpu 30变更](https://github.com/gfx-rs/wgpu/releases/tag/v30.0.0)
- [Cubism Native稳定发布](https://github.com/Live2D/CubismNativeFramework/releases)
