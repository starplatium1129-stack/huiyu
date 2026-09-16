# 004 — 反推满意图一键入库成场景（暂缓）

- **Status**: DEFERRED（2026-08-29 用户拍板暂缓：Ollama 常驻额外占显存，与 ComfyUI 生图抢资源，不值当）
- **Commit**: —
- **Severity**: LOW
- **Category**: Feature / Scene lifecycle
- **Estimated scope**: 4-6 文件，200-400 行

## 当前状态

### 已完成

- [x] 已记录“暂缓”决策：Ollama 常驻会与 ComfyUI 生图竞争显存，当前收益不足以启动本功能。
- [x] 现有作品册还原仍可找回出图状态，作为本需求暂缓期间的兜底路径。

### 待完成（暂不启动）

- [ ] 重新启动前确定 `story` 来源（本地 Ollama、用户手写或允许留空）及显存/服务条件。
- [ ] 增加满意图“存入场景库”入口，复用场景编辑器并接入 `scenes:import/build`。
- [ ] 完成蓝图/场景落库、版本管理、数据污染确认和浏览器行为验收；未重新授权前不执行。

## Problem

反推（WD14）推出词条 → 出图 → 非常满意时，当前只能靠**作品册还原**（成片级快照）找回当时的出图状态；无法把满意的「配方」落成**项目场景**（结构化数据资产），即：

```
反推词条(manualTags) + 风格层 + prompt/negative → 场景库 Scene
```

场景与作品册的差异：场景是长期资产——`title/story/character/tags/rating/mature/emotion/shot/lighting/composition/prompt/negative`，入库后进场景库参与场景选择器、批量出图、随机灵感复用，且走 `scenes:import/build` 管线与 DATA_VERSION 版本管理。

## 结构性缺口：反推给不了「故事」

WD14 是「看图识字」，只输出视觉词条，产不出场景库 story 的**剧本式叙事**（地点+动作+情绪+台词）。项目内 BLIP caption（WebUI）可看图说话但本机默认未启用，且只是画面描述、非叙事。

**story 字段的三选一来源**（方案要点）：
1. Ollama 本地 LLM 扩写（词条 → 叙事+台词，`services/ollama-service.js` + `routes/chat.js` 已有基础设施，加一个 prompt 模板即可）——**这是补缺口的路**，但因显存被否暂缓；
2. 用户手写一句话；
3. 留空——需放宽 `useSceneEditorModal.saveScene` 现「title+story 必填」校验。

## 实施要点（将来照此执行）

1. 入口：PromptBuilderView 结果区加「存入场景库」按钮（或作品册条目一键转场景）。
2. 预填：复用 `useSceneEditorModal` 表单——`tags=manualTags`、`prompt/negative=livePrompt`、`emotion/shot/lighting/composition=selections`、`rating` 按 `isManualR18Tags` 联动、`character`=studio 角色；用户补 title/story 确认。
3. 落库：走现有 `saveToProject` → `scenes:import/build`，天然带版本管理。
4. **热门角色**去向：无 LoRA 场景走蓝图体系，满意图更自然的去向是**一键转成该角色场景蓝图**（scene-blueprints.json，含 promptProse/promptTokens/决策字段），复用面更广（蓝图推荐/分镜/批量）。
5. 入库是全局共享资产（进 data/ 入库 Git），给确认提示避免误污染正式数据。

## 现状兜底

作品册（历史条目）还原已保证「不丢失」；本需求是体验升级（配方资产化），非必需。
