# HUIYU · GitHub 复用与参考项目调研

> 避免重复造轮子 · 功能实现参考与接入建议

> 2026-09-19｜基于 huiyu main 的工程调研

## 核心结论

核心结论：保留绘遇自己的 Scene、多引擎 Prompt 编译、角色约束、作品到再创作流程和品牌语言；图片手势、标签补全、焦点管理、虚拟化等通用能力优先复用成熟实现。大型 AI 创作项目主要学习模块设计和接口契约，不整体搬入。

## 1. HUIYU 当前基线

- HUIYU 已覆盖场景库、提示词工作台、SD / Anima / Krea 多引擎编译、Wan / MiniMax H3 视频、作品册、角色房间、语音、Live2D 与 Tauri 桌面伴侣。

- 前端为 Vue 3 + TypeScript + Pinia + Vue Router，已有 VueUse 与 Motion；后端为 Express / Node，桌面端为 Tauri 2。

- 作品册已有搜索、收藏、项目筛选、批量选择、回收站、作品对比、沿用配方、缩略图到高清渐进加载和分页渲染。

- 随机灵感已经包含角色身份排除、地点互斥、情绪/色彩联动、服装保护、画师策略和可测试随机源，不应被简单随机库替换。

- 提示词工作台已有中文释义、英文标准 Tag、分类搜索、WD14 反推与批量输入，后续应统一数据层而不是另建翻译系统。

## 2. 候选项目总览

| 项目 | HUIYU 对应功能 | 建议方式 | 优先级 |
| --- | --- | --- | --- |
| PhotoSwipe | 作品册沉浸观画 | 局部接入 / Spike | 高 |
| a1111-sd-webui-tagcomplete | Tag 中英文、别名、补全 | 借鉴数据模型并适配 | 高 |
| Dynamic Prompts | 随机提示词组合 | 借鉴模板与测试 | 高 |
| SwarmUI | 多引擎、视频、队列 | 架构参考 | 高 |
| InvokeAI | 作品、参数、再创作 | 架构 / UX 参考 | 高 |
| AIRI | 陪伴、音频、Live2D | 模块参考 | 中高 |
| Open-LLM-VTuber | 实时语音、打断、Live2D | 行为参考 | 中高 |
| Reka UI | 弹层、焦点、键盘 | 按需接入 | 中 |
| TanStack Virtual | 大列表 / 大图库 | 测量后决定 | 中 |
| fflate | 图库备份 / ZIP | 未来按需 | 中 |

## 3. 重点候选与对应关系

### 3.1 PhotoSwipe：作品册大图观赏

- 只考虑替换 Gallery 的通用观画交互，不替换展墙、作品数据、收藏、搜索、沿用配方、原参重跑和作品对比。

- 重点验证双指缩放、滚轮缩放、拖拽边界、连续切图、关闭后的焦点/滚动恢复以及资源释放。

- 避免嵌套两套弹层与两套 focus trap。验收标准是观赏体验确实优于现状，而不是仅仅“能打开图片”。

### 3.2 Tag Autocomplete：中英文、别名与搜索

- 英文标准 Tag 继续作为稳定 ID 和编译输入；中文负责理解与展示；aliases 负责搜索。

- 手动输入、随机灵感、图片反推、旧作品 Remix 都应落到同一份 Prompt 状态，再生成双语展示。

- 建议数据结构：canonicalTag + zhLabel + aliases + category + description + source/version。

- 借鉴成熟词典与补全 UX，不直接把 A1111 的 DOM 注入代码搬进 Vue。

### 3.3 Dynamic Prompts：随机灵感扩展

- 保留现有 randomPromptAssembler 的角色隔离、互斥规则和多引擎编译。

- 借鉴 Wildcard / 模板，让部分随机池从代码常量迁移为版本化数据。

- 区分“随机一次”和“生成 N 个候选组合”，并设置展开上限。

- 保存随机种子和配置快照，让满意结果可复现、比较和继续修改。

### 3.4 SwarmUI：多引擎与任务状态

- 重点学习能力契约：支持哪些输入、当前模型、是否适合执行、生成进度与预览。

- 逐步减少页面层 if(engine===...) 分支，把能力判断集中到 adapter / capability 层。

- 统一 Running / Pending / Completed / Failed / Cancelled 等任务语义，并区分模型加载、排队和生成。

- 只借鉴接口与状态划分，不迁移 C# 后端，不更换 HUIYU TypeScript / Express 技术栈。

### 3.5 InvokeAI：作品到再创作闭环

- 重点对照 Gallery、Metadata、Image Actions、Workflow 的职责分离。

- HUIYU 已有沿用配方、原参重跑和作品对比，下一步应检查参数恢复是否完整、差异是否清楚。

- 旧作品缺失模型 / LoRA / 引擎时给出明确兼容提示，避免静默改变生成条件。

- 目标路径：看到作品 → 理解生成条件 → 选择保留条件 → 回工作台继续创作。

### 3.6 AIRI / Open-LLM-VTuber：陪伴与语音

- AIRI 重点参考角色舞台、Live2D、音频 pipeline 与状态管理的模块边界。

- Open-LLM-VTuber 重点参考语音打断、TTS 生命周期、Live2D 与对话协作。

- 验收：打断后旧音频不再播放；切角色后旧请求不串会话；翻译/TTS 失败不锁死队列；隐藏窗口后减少无意义渲染。

- 保留 HUIYU 的 Tauri 路线，不因参考项目的桌面技术不同而整体迁移。

## 4. 通用底层：何时直接复用

| 能力 | 候选 | 引入条件 | 注意 |
| --- | --- | --- | --- |
| 弹层 / 焦点 / 键盘 | Reka UI | 出现复杂 Dialog / Popover / Select 行为时 | 只复用行为，保留 HUIYU 视觉 |
| DOM 虚拟化 | TanStack Virtual | 测量确认 DOM 数量是瓶颈时 | 不会自动解决图片解码、Blob 和瀑布流 |
| 压缩 / ZIP | fflate | 升级图库备份为 manifest + 原图包时 | 仍需自己设计版本、取消、失败与兼容策略 |

## 5. 推荐实施顺序

- P1：提示词词典与双语状态统一。先统一标准 Tag、中文释义、别名与搜索，并覆盖手输、随机、反推、Remix。

- P2：Gallery Viewer Spike。局部试验 PhotoSwipe，以触摸、缩放、切图、焦点和资源释放验收。

- P3：继续 009 性能测量。先完成真实资源趋势和高负载定位，再决定是否引入虚拟化；不以增加动画库代替性能优化。

- P4：生成 / 视频 Adapter 契约。对照 SwarmUI 收敛引擎能力、任务状态、模型加载和进度预览。

- P5：作品→再创作闭环。对照 InvokeAI 检查元数据恢复、兼容失败提示与 Remix 连贯性。

- P6：Companion 专项。推进 010 时对照 AIRI / Open-LLM-VTuber，重点完善会话生命周期、语音打断、角色隔离和 Live2D 适配。

## 6. 今后开发新功能的决策规则

- 先判断功能是 HUIYU 的产品核心，还是行业通用基础能力。

- 通用能力先检索 GitHub 成熟库和同类应用，确认维护活跃度、License、技术栈、包体积、兼容性和退出成本。

- 技术栈一致且边界清晰时优先小范围适配；技术栈不同时优先学习接口、状态机和测试，而不是整套移植。

- 不得为了复用而牺牲 HUIYU 的品牌语言、角色规则、Scene 数据模型和多引擎 Prompt 编译。

- 先做 Spike / 对照测试，再进入 main；必须能够说明相对现有实现具体改善了什么。

## 7. 长期 GitHub 参考清单

| 项目 | 仓库 | 对照模块 |
| --- | --- | --- |
| PhotoSwipe | dimsemenov/PhotoSwipe | Gallery Viewer |
| Tag Autocomplete | DominikDoom/a1111-sd-webui-tagcomplete | Prompt / Tags |
| Dynamic Prompts | adieyal/dynamicprompts | Random Prompt |
| SwarmUI | mcmonkeyprojects/SwarmUI | Generation / Video / Queue |
| InvokeAI | invoke-ai/InvokeAI | Gallery / Metadata / Workflow |
| AIRI | moeru-ai/airi | Companion / Audio / Live2D |
| Open-LLM-VTuber | Open-LLM-VTuber/Open-LLM-VTuber | Voice / Interrupt / Live2D |
| Reka UI | unovue/reka-ui | Accessible UI primitives |
| TanStack Virtual | TanStack/virtual | Virtualization |
| fflate | 101arrowz/fflate | Backup / Compression |

## 8. 最终原则

HUIYU 最不需要继续重复发明的是图片手势、标签补全、焦点管理、列表虚拟化等通用能力；最应该继续自研并打磨的是角色约束、Scene → 多引擎编译、作品 → 再创作闭环、角色陪伴体验，以及属于绘遇自己的观赏性和品牌语言。

本调研不代表候选库已经完成接入或性能验证。正式采用前必须进行源码/License 复核、最小 Spike、质量门禁和真实体验对照。
