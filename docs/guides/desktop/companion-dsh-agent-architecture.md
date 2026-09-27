# AI-CG-Studio 桌宠（Companion）DSH 架构对齐与配置指南

> **核对日期**：2026-09-27；原 DSH 对齐基线为 2026-08-20。
> **当前状态**：
> - **Live2D 原作者好感度系统**：已落地并有历史实机记录；包含动作奖励、原声台词气泡、好感度门控与状态徽章。奖励与解锁以实际选中动作的映射为准，历史检查不替代后续模型组合验收。
> - **多模态视觉看屏**：已接入原生截屏、浏览器分享兜底和图文消息；目标安装版、实际设备及兼容视觉模型的端到端验收继续按[未来规划](../../roadmap.md)的 V04 范围记录。
> - **自然语言绘画工具**：`generate_character_image` 只保存可编辑出图草稿，不提交生成、不产生插画，也不提前奖励好感度；用户需在工作台确认后出图。
> - **后续接手重点**：真实看屏/工具调用验收及草稿到真实生成队列的后续接线，见[未来规划](../../roadmap.md)。

---

## 🏛️ 一、架构对齐全景（DSH vs AI-CG-Studio 桌宠）

```
                     ┌────────────────────────────────────────────────────────┐
                     │                 AI-CG-Studio 桌宠伴侣                  │
                     │          （结合二次元灵魂人格与 DSH 工具执行力）          │
                     └───────────────────────────┬────────────────────────────┘
                                                 │
            ┌────────────────────────────────────┼────────────────────────────────────┐
            ▼                                    ▼                                    ▼
   【1. 多模态视觉感知】                 【2. 权威本地工具箱】                【3. 灵魂与演出引擎】
   • capture_screen                      • companionTools 协议                • Live2D 动作调度与原作者门控
   • 剪贴板图片感知                       • generate_character_image           • 好感度体系（0~100，Lv1~Lv5）
   • 主屏原尺寸 JPEG / 浏览器分享兜底     • read_image / read_file             • [mood=xxx] 情绪协议驱动
   • 原生直传视觉模型                     • write_file / run_command           • TTS 语音流式合成与唇形同步
```

### 1. 工具调用体系（Tools Mapping）

| DSH 原生工具 | 桌宠对齐工具 | 对应端点/实现 | 说明 |
| :--- | :--- | :--- | :--- |
| `read_image` | `capture_screen` / `read_image` | `/api/desktop-tools` (`name: capture_screen`) | 抓取 Windows 主屏画面或读取工作区图片，转为 Base64 DataURL；性能以实际设备测量为准 |
| `pwsh` | `run_command` | `/api/desktop-tools` (`name: run_command`) | 默认关闭；仅操作员启用 trusted 档后按当前系统账户权限执行，不是工作区沙箱 |
| `read` / `write` | `read_file` / `write_file` | `/api/desktop-tools` | 安全读写 AI 工作区内的文本、脚本、配置 |
| 维护出图脚本 | `generate_character_image` | `/api/desktop-tools` (`name: generate_character_image`) | 记录角色 Anima LoRA（0.85 权重）与描述的 JSON 草稿，返回 `status: draft`；未提交生成 |

2026-09-12 权限调整：文件工具解析实际链接目标，拒绝指向 AI 工作区外的目录联接；通用命令的启用和撤销见[启动与排错](../../../STARTUP.md#运行配置与凭据恢复)。进程起始目录、命令白名单和取消机制均不能当作操作系统级隔离。

---

## ⚙️ 二、推荐配置说明（与 DSH 保持一致）

### 1. 聊天与视觉大模型配置
在桌宠的 **设置（Chat Settings）** 面板中推荐配置：
* **供应商模式**：`API 模式`
* **API 地址（Base URL）**：
  - 本地代理端点：`http://127.0.0.1:8317/v1`（CLIProxyAPI / CPA-Manager）
  - 或官方 Gemini / OpenAI 兼容端点：`https://generativelanguage.googleapis.com/v1beta/openai/`
* **模型名（Model Name）**：
  - 使用所选供应商实际提供的模型；看屏需要图像输入能力，工具调用需要兼容的流式 Function Calling。模型可用性、延迟和工具稳定性以实际端点验收为准。
  - 本仓库预设由 `src/config/chatApi.ts` 与 `ChatApiSettings.vue` 管理，文档不另维护一套可能过期的推荐模型列表。
* **API Key**：填写您对应的 API 密钥。

---

## 🎯 三、核心场景操作指南

### 1. 屏幕感知与锐评（Vision Inspection）
* **操作**：在桌宠输入框右侧点击 **看屏幕**。
* **流程**：
  1. 优先通过本机网关调用 Windows GDI 截取主屏并编码 JPEG；失败时尝试浏览器分享屏幕，用户取消或设备不支持时返回失败；
  2. 自动组装多模态图文消息发送给视觉模型；
  3. 夏目/宁宁根据角色性格（毒舌傲娇 / 温柔学姐）以第一人称对您的屏幕画面进行点评。

### 2. 自然语言出图草稿（Tool Dispatch）
* **操作**：直接对桌宠发送指令：
  - *“夏目，帮我画一张你在海边喝汽水的插画”*
  - *“画一张夏目的泳装插画”*
* **流程**：
  1. 模型识别出图意图，发起 `generate_character_image` 工具调用；
  2. 网关在草稿中记录夏目 `L_NAT_V21_ANIMA` / 宁宁 `L_NENE_V21_ANIMA` LoRA（0.85 强度）；
  3. 草稿 JSON 写入 `AI_WORKSPACE_ROOT/generated-images/`，返回草稿路径；目录名不表示已有图片；
  4. 角色反馈草稿已准备、尚未生成。当前工具不自动提交 GPU 任务或增加好感度，需在工作台确认后出图。

### 3. 好感度与亲密度成长（Affection Loop）
* 互动按选中动作映射的 `bonus` 加分；部分摸头 / 摸手动作为 +5，专属动作或无奖励动作不承诺每次加分；
* 满分（100 分）解锁原作者专属告白动作（萌萌Q、喝茶邀请、我爱你）；
* 好感度徽章在顶部药丸实时显示当前等级与点数。
