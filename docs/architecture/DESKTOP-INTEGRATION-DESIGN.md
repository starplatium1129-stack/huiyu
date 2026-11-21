# 桌面启动、连接与能力边界实施规范

> 桌面宿主（Tauri 2）与本地 Rust 网关（`runtime-rs`）的启动握手、会话隔离、类型化桥接与打包边界。全局入口见 [工程契约](../engineering-contracts.md#重构期间的任务与持久化边界)，本机安装状态见 [项目状态](../project-status.md#源码与本机安装)。

---

## 1. 通信架构分工

- **Rust HTTP API**：承担全部业务查询、生图/视频提交与任务轮询（复用 `src/api/client.ts` 的响应校验、并发去重与 `runtimeEpoch` 代际保护）。
- **Tauri IPC**：仅负责可信 bootstrap、窗口管理、系统凭据、workspace 选择、通知、安装更新及原生 Live2D 能力，不将所有业务请求改写为 Tauri 代理。

---

## 2. 启动顺序与连接状态机

```text
Tauri 读宿主配置与活动 workspace 指针
  → 先行创建 bundled UI 窗口（不 await 网关就绪）
  → 异步拉起或验证受管 runtime
  → 核对实例身份、protocolVersion、workspaceId 与 runtimeEpoch
  → 发放桌面专属会话并初始化仓储与任务查询
```

```text
starting → ready → degraded → reconnecting → ready
        ↘ unavailable                     ↘ incompatible
```

- **异常恢复**：暂时断线时只读重查，不重发未知写操作；`runtimeEpoch` 变更即作废旧读取并重新握手；`protocol`/`workspace` 不匹配进入 `incompatible`，绝不连接占坑端口，也不以整页 `reload`/`navigate` 作为恢复手段。
- **降级展示**：网关离线期间允许继续查看已加载缓存、未提交草稿和诊断入口，明确标注只读/可能过期；未加载数据与写操作等待恢复。
- **退出语义**：关闭窗口即隐藏；显式退出应用时停止新准入、刷入取消/任务意图并有界关停自有进程（外部附着服务不强制杀除）。

---

## 3. Bootstrap、鉴权与私人会话

- **可信 Bootstrap（`desktop-tauri/src-tauri/src/bridge.rs`）**：仅对已登记的本地应用来源和允许的窗口标签生效，不接受前端传入任意端口、路径或目标 URL。宿主与子进程通过每次启动生成的私有握手材料相互核验，不依赖固定端口或健康接口，且握手材料不写普通日志或浏览器存储。
- **私人工作区会话**：
  - 全部 `/api/workspace/*` 与私人任务接口强制校验桌面专属内存认证 header（绑定 `workspaceId`、`runtimeEpoch`、`principal`、权限范围与有效期），`isDirectLocalRequest` 或共享网关 token 均不能越权访问。
  - CORS 仅放行已登记本地应用来源，禁用通配来源，OPTIONS 无副作用；继续保留 Host/DNS rebinding 与转发头校验。
  - 外部附着网关必须同样通过协议、实例与 workspace 绑定验证后才可提供私人库，否则进入只读或 `incompatible`。

---

## 4. 类型化能力与窗口路由

- **按消费者建窄接口**：桌面适配位于 `src/platform/desktop/`，Web 适配位于 `src/platform/web/`；禁止暴露无约束通用 `invoke(command, args)`。
- **窗口角色**：主工作台、Companion 与聊天窗口角色由宿主 bootstrap 权威下发并结合窗口标签校验（不靠 URL 猜测），跨窗事件传窄 payload 并配对清理监听。
- **桌面路由模式**：桌面打包构建使用 Hash History（配合统一 `route encoder` 处理窗口与 `aics://` 深链），Web 端保留常规 History。

---

## 5. URL 解析与媒体 Capability

| 资源类型 | 解析与安全策略 |
| --- | --- |
| 应用静态资源（JS/CSS/字体） | 随桌面应用包本地分发（`frontendDist`） |
| 运行时目录与动态清单 | 经统一 runtime URL resolver 解析，离线明确报错 |
| JSON 业务请求 | 经注入 transport 与边界解码器，禁止组件硬编码端口 |
| 图片 / 音频二进制 | 带认证 fetch 后转 Blob 并及时释放 Object URL |
| 大视频 / Range 请求 | 使用专用短期单资源读取 capability（支持 `HEAD/Range/206/416`），严禁把总网关 token 拼进媒体 URL 或日志 |
| 本机文件读写/导出 | 经窄 Tauri 文件选择器能力执行，不向渲染层开放任意路径读取 |

- 打包阶段（`tauri.conf.json`）严格隔离开发工具、模型文件、私人图片与迁移备份，确保其不进入 `frontendDist` 或网关公开资源。
- 升级协议校验 `protocolVersion` 与 `schemaVersion`；版本不兼容时只允许只读与诊断，严禁静默降级或关闭 CSP/远程安全门控掩盖故障。
