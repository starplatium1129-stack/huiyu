# 工程与角色接入契约

> 维护日期：2026-09-08。与 [AGENTS.md](../AGENTS.md) 配套阅读；此页保留模块约束，当前规模只维护在 [项目状态](project-status.md)。

## 模块边界

- **前端架构**：Vue 3 + Vite + TypeScript + Pinia（`src/stores/` + `src/views/` 路由全懒加载）。
- **组件与逻辑分层**：
  - 复杂业务逻辑与状态机下沉至专属 composable（如 `usePromptSdQueue`、`useAnimaInpaint`、`usePopularPromptAssembly`），保持 View 纯粹。
- **网关服务**：桌面 gateway 包由主工作区同一 `package-lock.json` 派生运行时依赖；`server.js` 的 SPA fallback 使用正则 `/^(?!\/api).*/`，保持对 Express 4/5 路由风格的部署侧兼容。
- **生图双引擎**：
  - **Anima (ComfyUI / Pencil)**：高质量动漫与局部换装（Inpaint），支持 TeaCache 加速、手绘/CLIPSeg 遮罩与 `ImageCompositeMasked` 像素级原图回贴。
  - **Krea 2（自研 DiT + Qwen3-VL 编码器，非 SD3.5 系）**：当前本地编译使用英文 prose，清理标签堆词、评分词和括号权重，negative 为空；CFG 以实际节点定义为准，不把本地约束泛化为所有版本能力。提示词按 [studio-prompt-craft](../.agents/skills/studio-prompt-craft/SKILL.md) 执行，人物环境融合见 [叙事 CG 规范](guides/prompts/narrative-cg-prompt-standard.md)；历史研究不覆盖当前实现与后续证据。
- **Live2D 双后端**：浏览器走 `wl-live2d`（按需加载贴图，`blinkScheduler` 双眼同步，静止动态降帧节能）；桌面端走原生 Overlay 桥。组合式拆分方案见 `docs/archive/completed/live2d-composable-refactor-plan.md`。
- **配音与陪伴**：GPT-SoVITS + 本机翻译管道，自动剥离台词舞台提示，长句分段与 in-flight 缓存去重。

作品历史/工作台的纯类型、配方解码、资源所有权和可执行依赖方向见 [可维护性试点边界](guides/engineering/maintainability-boundaries.md)。类型兼容转导出不改变持久化格式。

## Live2D 生命周期

destroyRuntime 保持全库唯一、Pixi-first 销毁顺序；双后端 capability 分支及 lifecycleToken 语义不能在重构时改变。拆分已完成，见 [完成记录](archive/completed/live2d-composable-refactor-plan.md)，不再列入未来待办。

## 角色接入

场景蓝图的 `compositionIntent` 可取 `single`（默认）、`group` 或 `triptych`。只有明确标记的 SFW 蓝图会放行多人或三格叙事；正文、人物数量、标签、镜头和画幅必须一起描述该构图。核心编译器与候选生成入口共用构图规则，不能在一端放行后又在另一端补回矛盾的单人/禁分格负面词。成人蓝图仍使用原有主体限制，构图字段不能改变成人资格或远程访问边界。未知取值视为无效蓝图。场景真实生成后由人工验收，不以参数通过替代画面通过。

数据层沿用既有 `adultEligibility: "adult"` 默认约定；远程访问授权仍以网关门控为准，字段默认值不能替代访问授权判断，也不能证明角色在具体剧情时期已成年。

角色接入必须同步完成以下六层：

1. **数据层与大盘**：`data/popular/<franchise>.json`（服装+蓝图）+ `data/characters.json`（人物档案、视觉DNA、性格世界观、`accent_color`）+ `npm run popular:build` 编译 `popular-characters.json`；
2. **UI 主题与强调色系统（必做项）**：在 `src/assets/css/director/tokens.css` 中为新角色注册专属主题与氛围光晕（`.pb[data-character="<id>"]` 与 `body:has(.pb[data-character="<id>"])`），配置 `--character-accent`、`--character-soft`、`--character-glow` 与 `--character-aura`，确保生图台与页面全局背景光斑丝滑响应角色切换；
3. **全量场景蓝图（SFW/NSFW 姿势解剖防崩）**：每位角色配齐 10~11 套场景蓝图（6~7 SFW 唯美日常 + 4~5 R18 成人专属）；成人蓝图严格遵守**「后入/俯身 $\rightarrow$ 强制 `1536x1152` 横画幅 + POV扶腰受力」**与**「仰卧/POV $\rightarrow$ 强制 `1152x1536` 竖画幅 + 揉胸/分腿层级」**黄金法则，杜绝悬浮器官与断腰；
4. **立绘原图与 WebP 紧凑头像缩略图**：在发布样张原图（`assets/characters/popular-<id>.png`）后，**必须同步执行 `python scripts/maintenance/build-character-thumbs.py`** 编译生成 `assets/characters/thumbs/popular-<id>.webp`，确保生图左侧选择器、首页横条卡片不掉头像；
5. **全视角参考标准库接入**：在 `data/character-reference-standards.json` 与 `data/character-reference-view.json` 中为新角色及所有服装形态注册 7 视角机位定义（面部特写/半身定妆/全身立姿/背影回眸 + 3 视角设计图），无资产形态先跑 `workflow reference:register` 登记 pending 占位（防 standards/view 漂移与断链），再执行 `node scripts/maintenance/render-all-outfits-references.js --ids=<角色id>` 完成资产补齐并跑 `sync-multi-outfit-standards.js` 回填 url；
6. **门禁、质检与桌面端同步**：必须跑通 `node scripts/tests/test-popular-content.js`、`npm run typecheck:app` 与 `npm run build`，并执行 `deploy-desktop.bat -SkipBuild` 完成桌面端闭环同步与 Git 推送。

自动化辅助入口见 [接入工作流](guides/characters/character-onboarding-workflow.md)。脚本执行成功不等于主题、头像、所有形态参考图和真实样张全部验收通过；必须逐层核对。场景数量是接入目标，不能为凑数覆盖已定稿内容；现存更多场景无需删减。
