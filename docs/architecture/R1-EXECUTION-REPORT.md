# R1：作品仓储收口与最小桌面 bootstrap

> 2026-09-26；基线 `089714c6b43cb9a7631ed896e9237400d91ba779`（R0 已快进 main）。R1 实现与定向验收完成，原生安装/WebView2 未验；实际命令、源文件身份和日志见 [R1 验证证据](../evidence/architecture-r1-2026-09-26.json)。

## 实现与保留边界

| 范围 | 本批结果 |
| --- | --- |
| 业务接口与真实装配 | `src/application/artwork/artworkRepository.ts` 定义纯业务能力；`src/storage/artworkRepository.ts` 默认装配 Web 实现，`configureArtworkRepository` 提供真实消费者使用的活绑定替换入口 |
| Web 仓储 | 现有实现移至 `src/platform/web/artworkRepository.ts`、`artworkReads.ts`、`artworkMedia.ts`、`artworkStorage.ts`、`artworkHardDelete.ts`；保留历史/项目读取差异、旧 localStorage importer、事务锁、回收站、未知提交保护与 Blob 所有权 |
| 实际消费者 | 生成保存、历史、Home、Gallery、灯箱、对比、导出、搜索、偏好和缩略图预热改用仓储；保留作品 ID、历史字段、项目引用与默认不自动入册语义 |
| 最小桌面 bootstrap | Rust `desktop_bootstrap` 复用宿主现有 secret 与 fresh challenge/HMAC 健康证明，按旧 origin 和宿主窗口 label 认证；只返回版本、窗口角色及已认证 runtime 描述，不返回 secret 或私人库会话 |
| 类型化调用 | wire DTO 位于 `types/desktop-bootstrap.ts`；`src/platform/desktop/bootstrap.ts` 校验响应，真实 `useDesktopZoom` 消费该能力，删除旧 shim 的两项 zoom 转发；普通 Web 不加载桌面模块 |
| 依赖护栏 | R0 精确旧边从 33 条减至 13 条，移除 20 条；封存 seed 不改，没有扩大允许范围 |

仍以 Web IndexedDB 为当前作品权威，没有启用新 workspace、双写或私人库 API，没有迁移用户数据或切换 UI origin。bootstrap 是 R1 的已接线窄能力，不代表 R8 完整会话、资源解析或 R9 bundled UI 已完成。

## 当次验证与修复

| 检查 | 状态 | 结果与限制 |
| --- | --- | --- |
| runtime 构建、架构、monolith、app typecheck | passed | 运行时代码与边界检查通过，单体预算覆盖 835 个源码文件 |
| 仓储相关前端定向回归 | passed | 6 个文件、76 项；复用现有行为测试 |
| bootstrap / zoom 前端回归 | passed | 6 项通过，其中新增 bootstrap 3 项 |
| Rust 离线 cargo 定向测试 | passed | bootstrap 2 项、origin 1 项、HMAC 1 项通过；证据为当次工具输出，无额外日志；不替代原生安装/WebView2 |
| Node 桥接 / 仓储回归 | passed | 14 项通过 |
| 首轮全量前端 | failed | 204 个文件中 203 个通过，1,428 项中 1,420 项通过；唯一失败文件 `promptBuilderHistory` 的旧 mock 导致 8 项失败及 1 个 unhandled error，原始失败保留 |
| mock 修复后定向复验 | passed | mock 改到新仓储边界后原 8 项通过；追加 `promptBuilderHistory` + `galleryStorage` 的真实 configure 调用共 11 项通过，companion 另 7 项通过；未将定向结果称为全量重跑 |
| 前端生产构建 | passed | 初次 ChatView 静态依赖闭包超预算；两处后台功能按需加载仓储后最终构建通过，ChatView 为 675.0 KiB / 680 KiB；保留初次失败 |
| 隔离库 E2E | passed | 指定 7 个流程全过，13.3 秒；端口 offset 18000、假上游、双页面 IndexedDB。覆盖 Home 两项 legacy、双页保存、并发追加/收藏/删除/恢复/备份、事务失败重试、staging GC 与 trash GC |
| 最终 app typecheck / 定向 lint | passed，exit 0 | app typecheck 通过；lint 首轮覆盖 41 个改动文件，仅 E2E 既有 unused args 报错，改为 `_args` 后最终 4 文件检查通过；47 条旧测试 any warnings 保留，未扩大修复范围 |
| SQLite 原型、完整 validate、新安装/WebView2 | not-run | 本批未执行；R0 缺失 2,534 张参考图的环境限制仍保留，不以本批通过覆盖历史 validate 失败 |

测试以复用为主，只新增 bootstrap 的 3 项前端/2 项 Rust 测试和少量存量仓储回归。真实模型、私人库激活和原生安装不属于本批已验证范围。

## 下一批

R1 实现与定向验收完成，R2 尚未实施。下一批从 `server/workspace/` 的 storage worker、单写者、schema、媒体 staging 与受保护 API 开始隔离实现；复用已有保存/恢复原型的行为断言，不将测试原型直接导入生产。实际 sidecar 中 SQLite 与 worker 的加载验证仍是 R2 启用 gate。R1 的原生安装/WebView2 尚未验收，本轮不提前激活新 authority。
