# 旧 Node 后端退役：暂停与续接任务

2026-10-02，用户因额度要求立即停止实现和验证，并要求抓紧提交合并。此提交是**未完成整合验收的工作现场**，不能记为全绿或可发行。未执行安装或发布。

## 已落地

- 分支 `codex/code-slimming-audit-20261002` 已合入主线 `d11a05e2`，保留上一轮精简 `4d903a2f`；当前工作位于 `D:/CodexCaches/worktrees/code-slimming-audit/AI-CG-Studio`。
- 旧 `server.ts`、`server/`、`routes/`、`services/` 共 165 个源码退出；实际需要的维护工具移到 `scripts/lib/`，前端来源判定移到 `src/platform/desktopOrigins.ts`。
- 旧库、回执、内容产物及任务指纹改用从 `142f654c` 捕获的固定样本与独立 SQLite 校验，未复制旧后端作替身。
- legacy 测试 lane 与旧命令退出；保留有效工具/前端测试，迁移三份浏览器夹具到真实 Rust。逐项测试退休映射见本目录 `node-retirement-test-map.json`。
- 合并重复原子写/网关 JSON 工具，删除版本空包装及前端无调用函数；Node 构建只剩 node/tests/browser 三项目；删除 Express、compression、http-proxy-middleware 及其专用类型依赖，锁文件已更新。
- 复现并修复 Rust watchdog 的旧探针/旧恢复结果污染新周期；补 trusted 命令进程树、token、代理 CONNECT/TLS 取消回归。修复空 NO_PROXY 的小写回落。
- InspirationDeck 改为 CSS 自定义属性承载原有变换，消除已知样式债违例；尚待双主题视觉验收。

## 已有当次证据

- `build:runtime`：node 231、tests 181、browser 6 源构建通过；后续少量修改仍需增量刷新。
- TypeScript 构建器隔离测试 14/14；Rust maintenance 16、control 12（晚探测矩阵复验）、token 1、images 3、task recovery 6 通过。
- 实际 Rust HTTP 读取旧 schema3 并继续写入，独立 SQLite/回执/媒体核对通过；1001→1002 行。
- desktop_tools 6/6，含父子进程取消、超时、64 KiB 输出上限、真实 TCP 断连回收。
- chat proxy 回归在共享客户端保持存活的情况下取消 CONNECT/TLS，确认 socket 关闭且后续请求成功；1/1 通过。Windows 大小写环境变量与 Unix 条件分支分开处理，Unix 未实跑。
- `npm run check` 20/21 步通过；类型、ESLint、对比度/动效/内容均通过。失败为卫生检查：blueprint-store.ts 尾随空白、两个固定 JSON 缺末尾换行。未运行到该 check lane 后续 9 项。
- 三浏览器探针：迁移双窗口已通过；图库与任务探针尚未收口（下列待办）。完整前端、完整 Rust、Node 各 lane、生产构建和 critical E2E **未完成当次整合验收**。
- 日志与中间映射在两个工作区的忽略目录 `runtime/node-retirement/`；原始第一轮证据仍在 `runtime/code-slimming-audit/`。不要用第一轮 PASS 替代这轮验证。

## 续接顺序

1. **先保护工作区**：E: 主工作区除了上一轮本任务的镜像修改，还有其他会话新产生的未提交测试修改。没有把它们带入本提交。远端 main 若已包含本提交，本地 main 可能仍停在 d11a05e2；先核对 `git status`、差异与分支，不得 reset/覆盖这些修改。优先复用 D: 隔离工作区继续。
2. **补齐源卫生与产物**：修 `scripts/lib/blueprint-store.ts` 尾随空白；为 `runtime-rs/tests/fixtures/legacy-content-products.json`、`legacy-scene-version.json` 补换行（确认是否有字节哈希绑定再同步说明）；跑 build:runtime 更新最近编辑的生成产物。重跑失败及未执行的 check 文件，不重复已经匹配源码的检查。
3. **处理快照恢复边界**：前端测试迁移发现 `runtime-rs/src/generation/snapshots.rs::drain` 原来未先拒绝 `jobs/{namespace}` 目录 symlink，可能触及目录外文件。Rust 子代理被中断时正在处理，须检查当前 diff，完成目录/文件链接拒绝、256 项和 7 天保留边界回归；不能把此项直接标已完成。
4. **收口静态 HTTP 断言**：Rust 子代理中断前在补 `/docs/art-direction.html?v=2` 的 308 重定向、未知路径/POST 不重定向、真实 static_files 压缩/ETag 链。确认代码是否落盘、编译并定向运行；真实路径带 `/docs`，不要新增根路径重定向。
5. **完成三份浏览器夹具**：`test-workspace-migration-browser.mts` 已过；图库探针的 Sec-Fetch-Site 采样应从路由暂停阶段改到 requestfinished，但保留真实 provenance 拒绝断言；任务探针需调整清理顺序，避免 Vite 先关使 route.fetch 错误遮盖真实失败。查看 `scripts/tests/rust-browser-fixture.mts` 和各探针当前 diff。探针只用轻量临时 app+Vite，不依赖 dist；最终执行仍需记录实际命令与退出码。
6. **核实覆盖映射**：映射仍为 review-in-progress；把新 watchdog/token/trusted/proxy/static/snapshot 行为及精确 Rust 测试名填入，复核 workspace thumbnail/backup 等是否指向真正专项，而非笼统同领域函数。未找到承接的有效断言必须迁移，不能为了清退删掉。旧实现私有结构检查可明确退出。`test-showcase` 已迁真实 Rust，待定向执行。
7. **检查原生验收清单**：`run-desktop-native-acceptance.ts` 曾错误要求 gateway/server.js、node.exe；测试代理已获授权改成 Rust EXE/两 DLL，暂停时检查其最终 diff及对应工具验证。旧文件拒绝/sentinel 夹具可保留。
8. **整合验收**：按当前 gate:full 所有阶段完成，含 Rust fmt/Clippy/默认测试、完整前端、核心 Node 与 tooling/release、生产构建预算。已有定向证据复用，仅重跑新增变更/失败影响面。之后执行 critical E2E，并对 InspirationDeck 做必要双主题桌面视口检查；实际 DPI/缩放、未跑设备/模型项目如实记录。
9. **文档与合并收尾**：当前说明文档已更新退役架构，但不应把本次未完成验收写为完成。检查 docs 链接、workflow/package 命令是否全存在、所有动态 require/path.join 是否仍触旧后端；完成后另提交验证结果并 push main。上一轮提到的原生 renderer 重复 ensure 清理尚未实施，可作为独立后续包，勿混同于旧 Node 退出已完成。

## 验证环境提示

- Windows Node v24.18.0；Cargo 位于 `C:/Users/Administrator/.cargo/bin/cargo.exe`。TEMP/TMP 使用 `fs.realpathSync.native(os.tmpdir())`，避免 8.3 路径守卫误报。
- D: node_modules 为复用依赖的 junction。Rust 浏览器夹具拒绝从 junction 读取原生 DLL；通过既有 `developmentNativeEnvironment` 在 E: 物理根核对 native manifest 哈希后，显式传入 `AICS_VIPS_DYLIB_PATH` / `AICS_ORT_DYLIB_PATH`，不要放宽守卫。
- 使用当前源码 debug EXE 设置 `AICS_RUST_RUNTIME_EXE`，浏览器端口偏移和证据目录独立。参考素材校验可用 structure 模式，但不等于实物验收。
- 本轮因停止要求没有完成安装、真实模型、原生视觉或发行材料验收。
