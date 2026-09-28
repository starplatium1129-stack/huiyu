# 桌面安装与构建修复（2026-09-28）

本机已将 `main@a520afc81435342b4e91af60e70bcf88a2a685a4` 完整安装到 `D:/AI-CG-Studio`，版本仍为 1.7.2。此次包含主线已合并的布局、维护与性能改进，以及本次角色主题按需加载修复。2026-09-28 17:47（Asia/Shanghai）安装后复核通过。

## 构建阻塞与修复

首次打包因绘制页 Web 包 148,483 字节超过 143,360 字节预算停止。未修改预算；将 159 套热门角色配色从同步依赖中分离，仅首次选择非工作室角色时加载，三位工作室角色仍同步可用。162 套主题的颜色与样式输出校验保持一致；切换、停用与卸载使用状态版本保护，避免迟到加载覆盖当前人物或泄漏到其他页面。

修复后 Web 绘制页包为 135,571 字节，按需主题目录为 13,428 字节。18 项定向主题与工作台测试、应用类型检查、构建/体积检查、单体预算及双主题 1,280 项角色对比度检查通过。实际浏览器在 1920×1080 深浅主题分别核验：默认人物不请求扩展目录，选择芙宁娜后只加载一次并呈现正确颜色，离开工作台后清除页面氛围。

## 完整安装与核验

通过 `npm run wf -- desktop:package-local` 重新生成本机未压缩安装包；完整流水线完成 Web、桌面 UI、Rust 后端、原生宿主和暂存资源核验。构建使用已经验收的 bundled UI 标记，生成的绑定回执对应上述源码提交。

随后只使用 `deploy-desktop.bat -UseInstaller -QuietInstall -InstallerPath <已绑定的本次安装包> -InstallDir D:/AI-CG-Studio` 安装。UAC 经用户确认，部署入口返回 0；未手动覆盖 EXE、强杀进程或删除 workspace 锁。安装后自动启动，另行复核结果如下。

| 项目 | 结果 |
| --- | --- |
| 安装目录 | `D:/AI-CG-Studio` |
| 认证维护状态 | `ready`；宿主拥有健康的 Rust 网关且存在原生窗口 |
| 运行实例 | 宿主 PID 25020，Rust PID 22288；后者父进程为当前宿主 |
| Workspace | 现有活动 workspace 的 owner PID 与该 Rust 实例一致 |
| 原生载荷 | 主程序、Rust EXE、libvips 与 ONNX Runtime DLL 均与绑定候选匹配；宿主按已有精确 NSIS 标记变换核验完整哈希 |
| 代理发起真实模型调用 | 0 次 |

| 构建 / 产物 | SHA-256 |
| --- | --- |
| 源码快照 | `3cc3801505646df683aacbb5cdb65fb973deef9abb2ae03c7e79851ec647d3e5` |
| 构建快照 | `78c59956bcb7e113c724538b7330df1d3b4a01a523c1f5290ba83fa9ec29c851` |
| 安装包（577,635,500 字节） | `ab23c9c98185b04659274956b704dff645c596053dce2dafed2507f48f7fb6a3` |
| 已安装宿主 | `d6d506f9d2a468eacbfa7efa2e2bff980e3ed6ada568f84ed3c3a8fc26287ac6` |
| 已安装 Rust 后端 | `3eab8f27559d0c64a552049cf84bf1261aa648645188de30c37b5d396c1278af` |

## 证据与边界

完整构建、部署日志和精简校验 JSON 留在被忽略的 `runtime/desktop-install-a520afc8/`；之前的构建失败与主题浏览器截图留在 `runtime/desktop-install-9ad54ba7/`，部署转录仍见 `runtime/desktop-deploy-last.log`。仅本汇总报告入库。

本次确认安装身份、进程所属关系与后端就绪，没有重新完成真实 Windows DPI、多屏或原生窗口图像验收。4K / 2K / 1080p 的已有浏览器验证范围见[桌面体验实施记录](desktop-experience-implementation.md)。没有发起真实生图、视频、语音或生产权重反推，也未发布 GitHub Release；本机安装不改变现有原生发行材料和设备验收的未完成状态。
