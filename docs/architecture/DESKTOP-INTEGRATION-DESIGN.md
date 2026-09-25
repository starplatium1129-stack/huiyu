# 桌面启动、连接与能力边界实施规范

> 设计规范，尚未接入生产。R1 实现最小安全 bootstrap；R8 收敛完整桥接/连接层；R9 才切换 bundled UI。入口：[总计划](REFACTOR-EXECUTION-PLAN.md)。

## 1. 默认选择，不再把 transport 留给下一轮研究

保留 Node HTTP API 作为业务传输，复用现有请求客户端和 provider 路由；任务进度初版继续可重连的 HTTP 查询。Tauri IPC 只管理可信 bootstrap、窗口、凭据、安装更新及原生能力，不把所有业务请求改写成一个 Rust 通用代理。

理由是现有 `src/api/client.ts` 已有响应校验、并发去重、消费者取消隔离和代际缓存；已有 generation/video API 能继续使用。此选择不意味着直接允许任意网页调用私人 workspace，新增会话与权限规则见第 3 节。

不同时引入 TanStack Query。先让 transport 独立、客户端按 runtimeEpoch 正确重建；R10 再按实际重复逻辑决定是否需要单一查询缓存。引入时必须删除被替代的缓存职责，不能套三层缓存互相失效。

## 2. 启动与状态

目标启动顺序：

```text
Tauri 读取宿主配置和活动 workspace 指针
→ 创建 bundled UI 窗口，提供只读宿主能力/连接状态
→ 启动或确认受管 runtime（独立异步阶段）
→ 校验实例身份、协议版本、workspaceId 和 runtimeEpoch
→ 建立桌面专属会话
→ 初始化领域仓储与任务查询
```

UI 启动不能 await 网关健康后才建窗。starting/unavailable 时也能显示说明、诊断入口和保留的编辑状态。

```text
starting → ready → degraded → reconnecting → ready
        ↘ unavailable                     ↘ incompatible
```

- 同一个 runtime 正在运行，暂时断线：重新查询，不重发未知写操作。
- runtimeEpoch 改变：旧 transport 的未完成读取失效，重新握手后重取数据/任务；旧响应不能回填新代缓存。
- protocol/workspace 身份不匹配：进入 incompatible，不自动连接碰巧占用原端口的服务。
- 不用 `navigate()` 或整页 reload 作为正常网关恢复方式。

**降级范围明确：** UI、诊断、未提交草稿、已加载的只读查询缓存和仍存活的 Blob 可以继续展示；标明内容可能过期。未加载作品、冷启动完整作品库和需要 runtime 的写操作等待恢复。禁止为了兑现“服务死了仍完整读库”而增加 Rust 第二仓储；若以后确有此要求，应另立独立存储服务的设计任务。

显式退出应用时停止新准入、刷入任务/取消意图并有界关停自有进程；超时升级到强制停止后，下次依照 ledger 对账。隐藏窗口不退出 runtime。外部附着的服务不因退出桌面而被杀死。

## 3. Bootstrap、鉴权和授权

### 3.1 最小 bootstrap 提前到 R1

在 `desktop-tauri/src-tauri/src/bridge.rs` / `main.rs` 增加窄 bootstrap 命令；返回协议版本、窗口角色、连接状态和经过验证的 runtime descriptor。私人会话仅在就绪且当前窗口受信时发放。

R1 仍在旧网关 origin 下工作，必须保持当前 `is_gateway_origin` 校验。R9 切 bundled origin 时，把信任切换成已登记的本地应用来源 + 允许窗口标签；不是删除 invoke handler 的检查。

bootstrap 不能接受 renderer 提供任意端口、文件路径或目标 URL。宿主与其启动的子进程使用每次启动生成的私有握手材料确认实例，不凭一条公共健康响应或固定端口授信。材料不得写普通日志、分享链接或持久浏览器存储。

### 3.2 私人库会话

- 新 workspace 接口始终要求专属会话，`isDirectLocalRequest` 或既有共享 TOKEN 均不能替代此校验。
- 会话绑定 workspaceId、runtimeEpoch、principal、权限范围与到期时间。身份由服务端建立，不信任客户端 body。
- HTTP JSON 请求使用内存中的专用认证 header。认证失败只重建会话/查询操作回执，不盲目重提 mutation。
- CORS 只回应明确登记的应用来源，OPTIONS 不执行任何业务变更；不使用通配来源授权私人库。不把 CORS 当作认证。
- 保留 Host/DNS rebinding、转发头、远程分级等现有防线。纯 Web 仍用自己的 IndexedDB；共享网关链接默认无法读取桌面作品、草稿、备份或私人任务。
- 外部附着 gateway 只有在单独验证支持相同协议、实例和 workspace 绑定后才可提供私人库；否则仅提供原有生成能力或进入不兼容状态，不能自动导入私人数据。

现有 `runtimeEnvironment.ts` 和 `server/security.ts` 已支持 Tauri 来源，不需要扩大“本机”定义。伪造 `window.companionDesktop` 或域名包含 tauri 不授予权限。

## 4. 类型化能力

接口按真实消费者建立：runtime bootstrap/connection、window、credentials、workspace selection、notifications、updater、native Live2D。不能通过一个无约束的 `invoke(command, args)` 暴露所有系统能力给业务组件。

建议新实现位于 `src/platform/desktop/`，Web adapter 位于 `src/platform/web/`；领域接口保持在相应 application/storage 边界。需要 Tauri JS API 时显式锁定兼容的 `@tauri-apps/api` 2.x 并更新 lockfile，不假设 CLI 依赖已经提供前端包。桌面模块按平台懒加载。

Rust serde DTO 与 TS wire 类型通过固定契约夹具、命令注册覆盖和非法输入测试校验；不以大量 `as any` 或复制字符串消除报错。初版不强制添加新的代码生成框架。

旧 shim 只能在尚未迁移的真实调用点上临时存活，登记精确调用点及删除批次。已迁移消费者直接调用新 adapter，不新增转发层把旧全球对象永久保留。R11 删除的是无消费者的桌面实现，不是仍供 Web 使用的存储/Live2D adapter。

窗口角色来自宿主 bootstrap，不从 `location.pathname.includes('companion')` 猜测。角色限制与窗口标签共同校验，跨窗事件采用窄 payload、revision/消息 ID 和完整 unsubscribe。更换路由模式后仍保留三个现有窗口的职责与关闭即隐藏语义。

## 5. URL 与媒体清单

切换前必须盘点真实 URL 消费者，至少覆盖 `fetch`、EventSource/WebSocket、img/video/audio、CSS url、worker、下载和 Live2D 模型依赖。不能只把 `/api` 加前缀就宣布完成。

| 类型 | 目标解析方式 |
| --- | --- |
| JS/CSS/font/必要启动图片 | 本地应用资源；与 Web dist 分开生成或 staging |
| 运行时目录、动态 data、模型清单 | 经统一 runtime URL resolver；offline 有明确加载失败状态 |
| JSON API | 经注入 transport 和已有 response decoder，不在组件硬编码端口 |
| 图片/音频二进制 | 小型内容可带认证 fetch 后转 Blob；及时释放 Object URL |
| 大视频/范围读取 | 使用专门媒体接口和短期、单资源读取 capability，支持 HEAD/Range/206/416 |
| 本地文件选择/导出 | 窄 Tauri 能力；不能给 renderer 任意文件系统路径读取接口 |

媒体 capability 仅允许特定对象、读取方法、到期时间与会话代际；不能把总网关 token 附加到每个 img/video URL。capability 只在内存使用，不写作品 metadata/日志/备份；日志删除查询凭据，Referrer-Policy 保持限制。暂停后过期可重新获取读取授权，不重新生成视频。

`useSDGenerate` 当前直接 fetch(resultUrl) 的路径必须迁移；其他 provider 返回的相对地址也经过同一解析器。禁止把上游任意 URL直接传给通用下载器。

CSP 同时覆盖 connect-src、img-src、media-src 和必要 blob/worker 场景，按实际打包来源测试。只移除有替代证据的 unsafe-eval/unsafe-inline，不为追求表面严格破坏现有 Web Live2D。不得为修一张图加入全局 `*` 或对任意远程来源开放原生能力。

## 6. Bundled UI 与构建

R9 采用桌面专用构建入口/模式，桌面路由使用 hash history，避免依赖网关的 SPA fallback；Web 维持原有 history 行为。主工作台入口、Companion、聊天和 `aics://` 深链由一个 route encoder 映射到对应 hash，不在多处拼接 URL。

这会改变 location.pathname，因此必须同步修改窗口角色判定、shim 退出路径、页面 CSP 判断和深链测试；不能只改 router 的一行配置。

沿用 `tauri.conf.json` 的 frontendDist staging 边界，构建脚本把桌面产物放到实际配置目录。只打包必要的公开启动资源；模型/私人图片/迁移备份不进入 frontendDist。Node 仍需要的 assets/tools/data 不因删除重复 web dist 被误删。

新增 storage worker、runtime `.js` 生成物、纯类型声明和依赖必须进入对应构建图与 gateway resources。共享运行时代码需要明确 TS rootDir、生成路径与资源映射；默认优先纯 DTO 类型共享和既有目录，而不是新建未经配置的根 shared 包。

安装包验收必须在没有 Vite 开发服务器、没有开发仓库相对路径兜底的环境中完成。验证 node.exe 版本、worker 入口、SQLite、媒体加载和三个窗口；开发模式成功不能代替打包成功。

升级协议包含 UI/runtime protocolVersion、workspace schemaVersion 和最低可写版本；不兼容时只读/诊断，不能偷偷回退旧库。应用身份和 WebView profile 路径不随这次重构改名。

## 7. R8/R9 验收与停止条件

隔离测试：

- 新旧 runtimeEpoch 响应乱序、写回执丢失、认证过期、协议不兼容。
- 旧网关来源/本地 bundled 来源的权限分别测试；其他网页、伪造桥对象、分享 token、错误窗口角色被拒绝。
- 监听注册/解绑成对，路由切换不产生重复轮询或跨窗口循环。
- 所有 URL 类型按清单测试；视频 Range、媒体凭据过期、Blob 释放与远程资源拒绝。
- 新旧 routes 的同一操作具有相同领域输入，提示词、模型选择、服装与安全策略不被架构改动改变。

Windows 实机：

- 冷启动时 runtime 故意失败，UI 仍能打开诊断页。
- kill 自有 runtime 后 UI 无整页导航；新实例握手通过后查询/任务恢复，未提交草稿不丢。
- 端口改变或原端口被其他程序占用时，不向错误服务发送私人凭据。
- Companion/聊天/工作台、深链、托盘、隐藏恢复、文件选择、更新、原生 Live2D 与 4K/150% 等实际设备行为。
- 完成旧 profile 剩余设置/聊天/会话数据的最后导出和校验后才开启新 origin。

上述安全、数据或资源门槛未通过，继续运行旧来源入口。不得用关闭 CSP、开放远程 IPC、清空用户数据或整页刷新掩盖失败。

技术依据：[Tauri capabilities](https://v2.tauri.app/security/capabilities/)；具体授权同时以本仓库自定义 invoke handler 为准，仅编辑 capabilities 文件不足以改变现有检查。
