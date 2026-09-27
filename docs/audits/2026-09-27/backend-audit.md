# 后端审计与优化（2026-09-27）

首轮检查 Node 网关的请求传输、任务提交/恢复、自愈控制、工作区 RPC 与媒体读取边界，直接修复三组已复现的取消与并发问题。第二轮按用户要求精简验证，优化进度连接、后端探测与存储热路径；隔离样本见下文，没有测量或宣称整体吞吐、内存、真实模型速度提升。

## 修复结果

| 位置 | 原问题与复现 | 本次实现 |
| --- | --- | --- |
| `services/http-client.ts` | HTTPS CONNECT 收到代理响应头之前未登记 abort；取消后最终得到 `UPSTREAM_TIMEOUT`。公网 DNS 检查也发生在取消监听和总期限之前。 | 从 DNS 开始登记统一取消/失败路径，将总期限覆盖 DNS、CONNECT、TLS 和响应读取；停止后忽略迟到完成，不再新开连接，释放监听和定时器，并销毁请求/响应流。 |
| `server/tasks/runtime.ts` | 同一尚未提交 intent 的任务收到两次 resume，provider 调用从 1 次变为 3 次；输入准备阶段也可能被 resume 越过。 | 同步占用 dispatch 槽、入口读回当前持久状态；准备期间不重复派发，完成后释放槽；resume 核对 provider 指纹，拒绝向已替换后端继续提交。关闭过程中尚未提交的任务保留为可显式恢复。 |
| `services/service-watchdog.ts` | 自愈定时器按旧托管状态重启；stop 后的迟到 probe 仍更新状态；健康探测可能提前释放正在执行的 restart 槽。 | 执行重启前重查托管状态，分别管理定时器和正在执行的重启；以生命周期代次拒绝旧 probe/restart 回填，阻止同一服务并发重启。 |

修复保留公网 DNS/IP 校验与地址绑定、直连连接池、任务的持久身份与显式取消、工作区单写权威。未引入依赖、持久化格式迁移、兼容 shim 或前端改动。

## 当次验证

环境为 Windows、Node v24.18.0；以下为本次实际运行结果。

- 三个行为测试文件新增 12 个回归；同时修正 HTTP 正向代理夹具原先使用回环目标而实际绕过代理的问题，新增代理实际访问次数断言。
- 修复前首次回归：30 项中 25 通过、5 失败，具体复现 CONNECT 取消、DNS 取消、手动停止后自愈、stop 后状态回填、重复任务派发。
- 增加隧道释放断言后曾出现两项测试超时；原因是 HTTP proxy 夹具的升级 socket 接收 EOF 后保留半开连接。补齐夹具的 EOF 收尾后，CONNECT/TLS 取消与连接释放均通过。
- `npm run build:runtime`：通过严格 TypeScript 检查与生成，覆盖 services、Node、tests、browser 项目。
- `node --test scripts/tests/test-http-client.js scripts/tests/test-service-watchdog.js scripts/tests/test-task-runtime.js scripts/tests/test-upstream-health.js scripts/tests/test-resource-scheduling.js scripts/tests/test-workspace-client.js`：46/46 通过，0 取消、0 跳过。
- 定向 ESLint：0 错误；最终覆盖四个测试文件及三个生产模块，既有测试中的 28 处 `any` 告警保留，未新增 `any`。ESLint 配置的模块类型告警与本次改动无关。
- `node scripts/tests/test-monolith-budget.js`：通过；`git diff --check`：通过。
- `node scripts/maintenance/gate-quick.js server`：Node 类型检查及 Anima、生成、视频、聊天、安全五组契约通过；随后桌面工具夹具在 CommonJS VM 中加载 `import.meta.env` 抛语法错误，控制契约因 fail-fast 未执行。原始日志保留在 `runtime/backend-audit-2026-09-27-c795db58/server-gate.log`。
- 修复 `test-desktop-tools-route.ts` 的浏览器环境夹具：用 TypeScript AST 注入桌面 Vite 环境，复用已安装 Vue，仅放行真实共享来源模块；生产桥/API 客户端和断连取消路径继续使用真实源码。
- `node --test scripts/tests/test-desktop-tools-route.js scripts/tests/test-control-failure-contract.js`：28/28 通过，覆盖真实 loopback HTTP 断开后自有父子工具进程退出。复用未受夹具修改影响的前五组通过证据，七组后端契约覆盖完成；没有将首轮门禁失败重标为成功。加上前述 46 项，定向验证共 74 项通过。
- `npm run wf -- docs:check`：234 份文档、1712 个本地链接、70 个重定向，0 失效链接。

测试使用临时工作区、独立 loopback 服务、受控 DNS/时钟和模拟 provider，不访问生产资料或真实生成服务。DNS 测试断言调用方及时结束且迟到解析不建连接；Node 底层 DNS 工作本身并非可中止 API。

## 交付范围

当前交付为源码与本机隔离验证。未执行完整前端/全库门禁、正式桌面安装、真实模型、设备或长期负载验收。工作区开工时已有的桌面/图库/Live2D 改动未改写、暂存或提交。本次按用户要求提交后端改动与审计证据，并同步远端。

## 第二轮：实际热路径优化

本轮未新增测试用例，只更新既有进度订阅回归，并执行四个受影响测试文件。一次性测量脚本放在被忽略的 `scripts/archive/backend-hotpaths-benchmark.cjs`，用相同脚本分别在修改前/构建后执行，性能样本与范围限制保留在[测量记录](../../evidence/backend-hotpaths-2026-09-27.json)。

| 改动 | 本机隔离样本结果 |
| --- | --- |
| 进度连接按任务订阅开启，最后一个订阅结束即关闭；空闲时停止重连 | 每个空闲 monitor 创建连接数 1 → 0；活动任务仍共用一条连接，断线后按原策略重连。 |
| WAI 状态与提交阶段的 WebUI/ComfyUI 探测并行执行，提交仍强制 fresh | 每个请求仍为六次上游访问；120ms 模拟响应下，冷状态探测中位数 251.2 → 128.1ms，Comfy 启动滞后 125.3 → 0.3ms。 |
| 项目关联只读取 ID 与删除状态，复用一个 statement，避免完整作品正文读取/解析 | 1000 条作品、每条约 8KiB 中性正文：SQL prepare 1012 → 13，中位数 23.1 → 7.5ms；关联顺序与字符串/数字 ID 保持。 |
| GC 在现有写事务内一次读取保护引用集合，复用删除 statements | 1000 个过期占位文件，500 个作品引用、250 个 lease 引用：保护查询 1750 → 1，SQL prepare 509 → 11，中位数 129.1 → 99.3ms；优化前后每个样本均删除 250 个无引用对象、保留 750 个保护对象。 |

存储与探测耗时各测三轮，空闲连接为单次构造计数；before/after 顺序运行。定时值仅为该夹具结果，不设置性能门禁或推算真实图库速度。引用快照只在当前 `BEGIN IMMEDIATE` 事务内使用，没有增加长驻缓存或改变清理保留期、持久格式与工作区写权威。

当次严格 runtime 构建、四个受影响既有测试文件、单体预算与 `git diff --check` 通过。定向 ESLint 0 错误，21 处原有 `any` 告警保留。生成/Anima 使用模拟上游，存储使用临时库；未调用真实模型、部署或扩大为全量门禁。

## 提交时同步远端

同步远端 `462f9ef2`，保留其批量删除、缩略图清理和已有桌面工具夹具修复。本提交不再重复替换上游已修复的夹具；项目 ID 读取与 GC 引用快照优化同时保留。

同步后严格 runtime 构建、工作区存储/缩略图/桌面工具三个受影响既有测试文件通过（23 项 Node 测试，存储文件另有 72 项内部检查）。未重复运行不受影响的全量检查。

同步后同一测量脚本再跑三轮：项目 SQL prepare 仍为 13，GC prepare 为 11、保护引用查询为 1，空闲进度连接为 0。中位耗时分别为项目 5.6ms、GC 127.5ms、探测 137.1ms；详见样本的 `afterRemoteIntegration`。上表 99.3ms 是同步前 GC 结果；新 GC 增加缩略图路径核对与回收，耗时不能直接解释为同一工作量下的纯优化差值。
