# 1.7.4 构建、离线资源与有限优化

记录日期：2026-09-30。范围为图库读取调度、协作/验证规则、旧缓存可恢复隔离、现行文档校准、1.7.4 发行材料与 r1 资源的隔离导入。1.7.4 正常安装已完成；公开发行状态见 [版本页面](https://github.com/starplatium1129-stack/huiyu/releases/tag/v1.7.4)。

## 已完成结果

| 工作包 | 结果 | 证据口径 |
| --- | --- | --- |
| 协作与验证规则 | 明确文件归属、合批修改、风险分层验证和停止标准 | 当前 AGENTS.md；文档小改不重复全量测试/构建 |
| 图库缩略图读取 | 60 条记录的重复读取 180→60，峰值并发 24→8；筛选后过时队列不再继续启动，保留目标仍读取 | Vue/KeepAlive 延迟读取夹具；4 个定向文件 23 项通过、应用类型检查和单体预算通过；不推算真实新机帧率 |
| 旧缓存隔离 | 4,136,146,518 字节、3,135 文件（3.852 GiB）移至 `runtime/workspace-quarantine-20260930`，保留恢复路径 | 同盘移动已执行，没有删除，空间释放 0；不是完整打开句柄或磁盘分配量证明 |
| 现行文档 | 离线资源与 TypeScript 指南校准 Node→Rust、源码/成品边界、版本和实际参数；本报告补齐发行入口 | 先前两份指南的 9 个本地链接及命令映射检查通过；本次仅最小格式核对 |
| 1.7.4 发行构建 | 安装入口、更新签名、校验文件及构建绑定已生成，发行入口验证签名/字节一致 | 构建与正式安装分开；不称为 Windows Authenticode 或设备验收 |
| 1.7.4 正常安装 | 宿主、Rust EXE及两份DLL与候选哈希一致，不带 Cleanup，按 NoRestart 保持退出 | 既有部署入口及 NSIS；安装后桌宠/GUI 未另验 |
| r1 ZIP 导入与重启 | 隔离新用户目录实际导入；1.7.4 Rust 网关两次启动均读取同一 SFW 原图、缩略图和基础资源，挂载身份一致 | 来源不可用、子进程 PATH 无 Node、AI 工作区不存在；未触碰正式配置、未调用模型 |

r1 快照记录 `appVersion=1.7.3`，原生导入按 schema、独立审批指纹和文件身份核验，可供本次 1.7.4 使用。保留旧包字节，无需重新导出。安装脚本由 PowerShell/.NET 读取 ZIP，再调用安装目录 Rust EXE；默认使用程序登记路径与 `%APPDATA%/com.aics.studio` 用户目录，无开发机 E 盘或源码依赖。

## 证据位置

原始 JSON、日志、安装包和 ZIP 留在被忽略的 `runtime/`，不随源码报告入 Git：

- `runtime/frontend-gallery-optimization-20260930/performance-evidence.json`：前后读取数量、并发及定向检查。
- `runtime/workspace-round2-inventory/isolation-manifest.json`：已执行同盘隔离、字节/文件数量、保留范围与恢复位置。
- `runtime/docs-drift-20260930/validation.json`：两份现行指南的有限校准检查。
- `runtime/release-1.7.4-20260930/result.json`、`final-binding.json`：1.7.4 构建身份、安装入口与更新签名的摘要及发行入口核验。
- `runtime/release-1.7.4-20260930/installation-result.json`、`runtime/desktop-deploy-last.log`：正常安装与哈希匹配回执。
- `runtime/release-1.7.4-20260930/offline-browser-evidence.json`：真实 ZIP 导入后两次 Rust 启动的 SFW HTTP 字节证据。
- `runtime/offline-delivery/r1/`：既有完整资源 ZIP、原始元数据与配套材料。历史目录中的 1.7.3 安装器或 VC++ 文件不自动成为本轮公开附件。

正式附件及两种不同 SHA-256 见 [v1.7.4 发行说明](../../releases/v1.7.4.md)。本次附件不转载 VC++，用户须在联网准备机从微软官方取得离线材料，再在新机处理安装、许可、UAC 与重启。

## 未完成及范围限制

1.7.4 本机安装已完成，资源仅在隔离目录导入，未称为正式用户资源导入。隔离 Rust 服务的重启与图片字节证据不等同于干净 Windows 新机、物理断网、桌面 GUI、WebView2/VC++ 前置安装或全部 1,640 样张的视觉验收。真实模型、GPU、音频及长期资源趋势也未因此补验。

公开完整资源范围已获用户授权，保留历史元数据 All 924、R15 153、R18 563。本包没有审查/改写排除内容，没有调整分类/过滤，也没有把打包复制称为图片审核。

源码 MIT 与第三方资源/组件许可分别核对；未知资源许可不写成已解决。[原生许可 README](../../../runtime-rs/native-licenses/README.md)仍记录链接清单、完整对应源码/工具链、许可路径与目标设备替换验证等未闭合事项。此次不新增许可研究，也不把用户的发布授权当作第三方许可结论。
