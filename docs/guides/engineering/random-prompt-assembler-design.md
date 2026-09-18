# 随机灵感（Random Prompt Assembler）设计文档

> 2026-09-08 状态说明：本文保留专题方案或历史实验依据；其中规模、参数与待办不作为当前状态。现状见 [项目状态](../../project-status.md)，执行优先级见 [未来规划](../../roadmap.md)；实施前核对当前数据与生产配置。


> **状态**：P0 已落地（2026-08-29）；P1/P2 待做
> **范围**：导演台「随机灵感」骰子按钮，复用项目现有标签资产与编译管线，输出 SD / Anima / Krea2 三引擎兼容提示词。
> **P0 交付**：`src/utils/randomPromptAssembler.ts`（纯函数采样器）、`src/stores/promptBuilderStore.ts`（snapshot/restoreStyleLayers 撤销）、`src/composables/useRandomInspiration.ts`（桥接）、`src/components/RandomInspirationButton.vue`（骰子按钮 + 随机画师开关 + 撤销）、`ArchiveIcon` 新增手绘 `dice` 图标、`scripts/tests/test-random-prompt.js`（9 用例全过，已纳入 quality-test-inventory）。
> **关联**：`src/utils/promptCompiler.ts`（渲染管线，零改动）、`src/config/artistStyles.ts` / `artistStyleCatalog.ts`（画师白名单）、`data/tags.json`（标签池）、`data/loras.json`（官方服装）、`src/config/promptConstants.ts`（镜头/光照/构图/色彩常量）、`src/stores/promptBuilderStore.ts`（目标写入状态）。

---

## 1. 背景与目标

导演台目前由用户手动选择情绪/镜头/光照/构图/画师来组装提示词。需求是提供「随机组装」能力：一键生成一组风格层标签，与现有管线无缝衔接，并保证三引擎（SD/WAI、Anima、Krea2）语法正确。

**设计原则**：

1. **渲染零改动**：`createPromptPlan → renderPromptPlan(engine)` 已完整实现三引擎语法（Danbooru 标签流 / `@artist`+空格标签+caption / 3~5 句英文散文）。随机功能只生产 `PromptCompilerInput`，绝不触碰渲染器，避免引入新的语法分支。
2. **身份契约不可破**：随机只发生在「风格层」（服装/场景/动作/情绪/光照/镜头/构图/色彩/画师），角色身份（`charPrompt` + LoRA 精确 token）永远固定。
3. **单一 R18 遮罩原则**：Mature 池不设独立开关——本地直连本就放行，「正常/非正常」只由评级层（显式门控词 + 评级字段）区分，遵循既有契约语义（详见 §5）。
4. **可单测**：采样器是纯函数（可选注入 RNG），固定种子下输出确定。

## 2. 架构总览

```
标签资产池（现有数据）──┐
  tags.json 11 类 510     │ 随机采样
  官方服装 outfit_guidance │  randomPromptPlan()
  画师白名单 39           │  （纯函数，注入 RNG）
  promptConstants 常量池  ┘          │
                                     ▼
                        PromptCompilerInput
                                     │
                                     ▼
                  现有编译管线（零改动）
                  createPromptPlan → renderPromptPlan(engine)
                          │              │              │
                          ▼              ▼              ▼
                     SD / WAI        Anima          Krea 2
                  Danbooru 标签流  @画师+空格+caption  3~5 句英文散文
```

UI 层：导演台顶部「随机灵感」骰子按钮 → 把采样结果**写入 store**（`selections.emotion/shot/lighting/composition`、`colorMood`、`manualTags`、`artistStyleIds`），现有 `usePromptAssembly` 自动重算 `positivePrompt/negativePrompt/previewPrompt`。用户可手改、可连点重掷、可撤销上一组。

## 3. 数据池清单（全部复用现有资产，不新增数据）

| 池 | 来源 | 规模 | 随机策略 |
| :--- | :--- | ---: | :--- |
| 角色身份 | `characters.json traits` + store `charPrompt` | 宁宁 6 / 夏目 5 | **固定层**：只可能随机勾选 1~2 个非核心特征，不触碰身份 token |
| 官方服装 | `loras.json outfit_guidance`（V18 WD14 为事实源） | 宁宁 5 套 / 夏目 4 套 | 每掷 1 套（60%）或通用款（40%） |
| 通用服装 | `tags.json` Clothing | 131 | 与官方服装二选一 |
| 场景/地点 | `tags.json` Scene | 90 | 0~2 个（室内外互斥） |
| 动作 | `tags.json` Action | 63 | 0~1 个 |
| 情绪 | `tags.json` Emotion + `promptConstants.EMOTION` | 63 + 16 | 1~2 个（同类互斥） |
| 光照 | `tags.json` Lighting + `promptConstants.LIGHTING` | 36 + 6 | 1~2 个（互斥组） |
| 镜头 | `tags.json` Camera + `promptConstants.SHOT` | 31 + 10 | 1 个 |
| 构图 | `promptConstants.COMPOSITION` | 7 | 0~1 个 |
| 色彩情调 | `promptConstants.COLOR_MOODS` | 6 | 0~1 个 |
| 外观特征 | `tags.json` Appearance | 30 | 0~2 个 |
| 画师 | `ARTIST_STYLE_OPTIONS` | 39 | **默认 0 位**（保留原生画风）；「随机画师」开关开启后 0~2 位 |
| Mature | `tags.json` Mature | 47 | 20% 概率抽 1~3 个（零新增门控，规则见 §5） |

## 4. 采样规则

### 4.1 固定层（永不随机）

- 当前角色（`nene` / `natsume` / `triad`）与 `charPrompt` 身份行。
- LoRA 精确控制 token（`characterControlTokens` 产出，含 `ayachi_nene` / `natsume_r18` 等 exact token 与 `nene_` / `natsume_` 前缀，SD 下保留下划线、Anima 走 `exact_prefixes`）。
- 已启用的画师（若「固定画师」勾选，重掷时保留 `artistStyleIds`）。

### 4.2 随机层（每类数量与权重）

| 项 | 抽取数 | 权重/规则 |
| :--- | ---: | :--- |
| 官方服装 vs 通用服装 | 1 | 官方 60% / 通用 40%；triad 时不抽服装（双人各穿各自官方服） |
| 场景 | 0~2 | 70% 抽 1 个，30% 抽 2 个；抽到 `indoors` 后不再抽户外系 |
| 动作 | 0~1 | 50% 不抽 |
| 情绪 | 1~2 | 70% 抽 1 个，30% 抽 2 个（互斥组见 4.3） |
| 光照 | 1~2 | 60% 抽 1 个，40% 抽 2 个（互斥组见 4.3） |
| 镜头 | 1 | 100% 抽 1 个 |
| 构图 | 0~1 | 50% 不抽 |
| 色彩情调 | 0~1 | 50% 不抽；与情绪弱联动（happy→joy/love，calm→calm 等） |
| 外观特征 | 0~2 | 50% 抽 1 个，20% 抽 2 个 |
| 画师 | 0~2 | **默认 0 位**（不注入，保留角色原生画风）；仅「随机画师」辅助开关开启时：60% 抽 1 位，20% 抽 2 位，20% 不抽 |

去重：全量标签先过 `Set` 去重；与身份行 / 场景模板已含的标签去重（复用 `promptBuilderStore` 现有 manualTags 去重逻辑思路，见 §7.3）。

### 4.3 互斥组表（同一掷内不同时出现）

| 互斥组 | 说明 |
| :--- | :--- |
| 光照：`golden_hour` vs `moonlight` vs `lantern` vs `window_light` vs `overcast` | 一次至多一个主光照，可附加 `backlight`（逆光可叠加） |
| 室内外：`indoors`/`classroom`/`bedroom`/`cafe` vs `outdoors`/`beach`/`park`/`rooftop` | 场景抽中一侧后，另一侧全部排除 |
| 情绪：`happy` vs `sad` vs `calm` vs `serious` | 一次至多一个基调情绪；`blush`/`heavy_blush` 由编译器 `compactMood` 二次兜底合并 |
| 服装：官方套装各 key 之间互斥 | 一次至多一套官方服装（`official_witch` 与 `official_school` 不同时出现） |
| 时间：`night`/`late_night` vs `morning`/`sunset` | 场景时间互斥 |
| 天气：`rain`/`snow` vs `clear_sky` | 天气互斥 |

> 兜底：即使采样器漏了互斥，编译器已有去重/合并（`dedupeParts`、`compactMood`、Krea 环境去重逻辑），不会产出语法错误，只可能信息冗余。

### 4.4 画师过滤规则

- **默认不注入画师 tag**（2026-08-29 用户要求）：角色自身常带原生画风，不加画师反而更「原滋原味」。骰子默认产出 0 位画师；只有开启「随机画师」辅助开关时才从白名单随机。
- 「固定画师」独立于上述规则：用户已在画师选择器手动选中的画师，重掷时**保留不动**（不因随机而丢失，也不被随机覆盖）。
- 开启「随机画师」后，成人向画师（`atdan`、`hisasi`、`suimya`、`xinzoruo`）在 Mature 标签未参与的掷次中权重减半。
- 随机画师结果必须通过 `normalizeArtistStyleIds` 归一（别名消歧 + 白名单校验 + 上限 2），与现有入口完全一致。

## 5. Mature 参与规则（单一 R18 遮罩原则）

> 2026-08-29 用户原则确认：**本机使用 = 自由创作**。全项目只保留一个 R18 遮罩——评级层（`nene_r18` / `natsume_r18` 门控词 + 评级字段），用于区分正常/非正常内容；除此之外没有任何东西应该挡在用户与创作之间。本功能遵守该原则：**不新增任何开关、不做任何角色/用户资格校验**。

- **本地直连即放行（现状事实）**：生成链路（`generation.js` / `desktop-tools.js` / `anima/validation.js`）对 127.0.0.1 直连与 Tauri 桌面端已全部 bypass（`security.isDirectLocalRequest`）。注：此前的 4 处实现漂移曾误伤本机用户（2026-08-28 审计 P1-6 后统一并纠正），当前 SD 本地生成固定传 `adultEnabled:true`、Anima 本地默认 adultEnabled。
- **单一遮罩 = 评级联动**：每掷 20% 概率从 Mature 池抽 1~3 个；抽中 `nude`/`naked`/`nipples`/`sex` 等词时与显式门控词一起写入 `manualTags`，由现有 `effectiveScene.isManualR18` 逻辑自动把评级提升为 R18——这就是「正常/非正常」的**唯一**区分层。
- **不做什么**：不做角色资格校验、不做额外开关、不做二次确认。本功能仅作用于 studio 角色（宁宁/夏目，数据契约均为 adult），遮罩天然不拦任何角色。
- 云端后端（Anima/Krea）的传输层授权由现有 `isLocalStudioHost()` 派生，与随机功能解耦，不在此重复。

## 6. 三引擎输出映射（复用现有渲染器）

采样器只产出 `PromptCompilerInput`，各引擎语法由 `renderPromptPlan` 保证：

| 引擎 | 渲染路径 | 随机标签如何进入 |
| :--- | :--- | :--- |
| SD / WAI | `promptParts` 标签流 | 服装→场景模板替代；动作/情绪/镜头/光照/构图/外观→`manualTags`；画师→`artistStyleIds`；`<lora:...>` 由 `loraSpecs` 现有逻辑追加 |
| Anima | `renderPromptPlan(plan,'anima')` → 空格标签流 + 一句 caption | 同上写入 store，`usePromptAssembly` 自动编译；`@artist` 由 `artistTagsForEngine` 生成 |
| Krea 2 | `renderPromptPlan(plan,'krea2')` → 3~5 句英文散文 | `promptCompiler` 内置 `ACTION_REWRITES`(200+) / `MOOD_REWRITES` / `CAMERA_REWRITES` / `LIGHT_REWRITES` / `ENVIRONMENT_REWRITES` 把标签转英文词组；未覆盖的标签走 `proseToken()` 兜底（下划线→空格） |

**Krea2 兜底策略**（关键风险点）：

- 预检：`scripts/tests/test-random-prompt.js` 对 tags.json 全部 510 标签跑一次 `proseToken`/`actionPhrase` 等映射，统计「自然英文覆盖率」；目标 ≥ 90%。
- 对覆盖不足的类别（预计 Appearance/Body 部分标签），在 `promptCompiler` 的映射表**增量补词**（不改渲染结构，只加映射条目），或在采样器中过滤掉无法 prose 化的标签（保守选项，v1 采用）。
- Krea 渲染自带 `sanitizeKreaProse`（禁 `(tag:1.5)` 权重、禁下划线、禁 score/质量词），随机标签注入后同样过此净化，不会漏。

## 7. UI 交互设计（导演台）

### 7.1 骰子按钮

- 位置：导演台顶部模式切换（basic/pro）旁，独立「随机灵感」按钮，带骰子图标（复用 `ArchiveIcon` 手绘图标集，新增 `dice` 图标或复用 `spark`）。
- 行为：
  1. 点击 → 采样器按当前角色+引擎生成一组 → 写入 store → `previewPrompt` 自动刷新。
  2. 连点 → 重新掷（角色、已选场景、画师固定项保持）。
  3. 基础模式同样可用（无画师注入、无专家参数，只随机场景层）。
- 辅助控制（按钮旁小图标，不占主布局）：
  - 「随机画师」开关（**默认关闭**）：开启后骰子才从画师白名单随机 0~2 位；默认不加画师 tag，保留角色原生画风（见 §4.4）。
  - 「固定画师」锁定：用户已手动选中的画师在重掷时保留不动（与「随机画师」独立，两者可同时开）。
  - 「撤销」：记录上一组写入前的 store 快照（emotion/shot/lighting/composition/colorMood/manualTags/artistStyleIds），一键回退；仅保留最近一组。

### 7.2 结果可见性

- 随机结果不是黑盒：写入 store 后，用户在下方面板能看到并手改每一项（情绪/镜头/光照/构图 chips、手动标签区、画师区）。
- 随机命中时给出轻提示（如「随机灵感已应用，可继续手改或再掷」），复用现有 `flash` toast。

### 7.3 与 manualTags 的写入去重

写入 `manualTags` 前，复用现有逻辑：剔除与场景模板重复的标签（`promptBuilderStore` 已按 `templateKeys` 去重）；剔除与身份行重复的（如 `white_hair` 不重复进 manual）。避免随机把 `1girl`/`solo` 等元标签混入（由采样器直接过滤）。

## 8. 模块与文件清单

### 8.1 新增文件

| 文件 | 职责 |
| :--- | :--- |
| `src/utils/randomPromptAssembler.ts` | 纯函数采样器：`randomPromptPlan(options): RandomDraw` |
| `src/composables/useRandomInspiration.ts` | 桥接：读 store → 调采样器 → 写回 store + 撤销快照 + toast |
| `scripts/tests/test-random-prompt.js` | node:test 单测（固定种子确定性、三引擎健壮性、遮罩一致性、覆盖率统计） |
| `src/components/RandomInspirationButton.vue` | 骰子按钮 + 随机画师开关（默认关）+ 固定画师 + 撤销（拆组件避免 PromptBuilderView 膨胀） |
| `docs/guides/engineering/random-prompt-assembler-design.md` | 本文档 |

### 8.2 修改文件

| 文件 | 改动 |
| :--- | :--- |
| `src/stores/promptBuilderStore.ts` | 导出 `snapshotStyleLayers()` / `restoreStyleLayers()` 供撤销使用（不新增任何门控状态） |
| `src/views/PromptBuilderView.vue` | 顶部挂载 `RandomInspirationButton` |
| `src/utils/promptCompiler.ts` | 仅当 Krea2 覆盖率预检不达标时，增量补 `*_REWRITES` 映射条目（预期小改动） |
| `docs/INDEX.md` | 登记本文档（维护契约要求） |

### 8.3 接口签名（草案）

```ts
// src/utils/randomPromptAssembler.ts
export interface RandomInspirationOptions {
  char: 'nene' | 'natsume' | 'triad'
  directorMode: 'basic' | 'pro'
  includeArtists?: boolean     // 「随机画师」开关，默认 false（不加画师 tag，保留原生画风）
  keepArtists: string[]        // 固定画师（用户手动已选，重掷保留；可空）
  rng?: () => number           // 注入随机源（测试用，默认 Math.random）
}

export interface RandomDraw {
  outfit?: string              // 官方服装 key 或通用服装标签
  emotions: string[]           // emotion prompt 词
  shot?: string | null
  lighting?: string | null
  composition?: string | null
  colorMood?: string | null
  sceneTags: string[]          // 场景/动作/外观等 → manualTags 候选
  artistStyleIds: string[]     // 归一后画师 id
}

export function randomPromptPlan(options: RandomInspirationOptions): RandomDraw
```

## 9. 测试计划（`scripts/tests/test-random-prompt.js`）

| 用例 | 断言 |
| :--- | :--- |
| 固定种子确定性 | 同种子两次采样结果完全一致（快照对比） |
| 白名单与归一 | 开启「随机画师」时，画师结果全部通过 `normalizeArtistStyleIds`；非白名单 id 永不出现在结果 |
| 默认无画师 | `includeArtists=false` 时 100 次采样 `artistStyleIds` 恒为空（保留角色原生画风） |
| 固定画师保留 | `keepArtists=['kantoku']` 时重掷 100 次，结果恒包含 `kantoku` |
| 身份契约 | 任意 200 次采样，`charPrompt` 身份行与 LoRA exact token 恒存在且未被修改 |
| 三引擎健壮性 | 200 次随机 × 三引擎 `renderPromptPlan` 不抛错；SD 无 `@` 前缀错误、Anima 画师带 `@`、Krea 无下划线/质量词/`@`/`(x:1.5)` |
| Krea 覆盖率 | tags.json 全 510 标签映射覆盖率 ≥ 90%（v1 保守目标） |
| 遮罩一致性 | 500 次采样：Mature 标签只与显式门控词一起出现（评级联动为 R18），无任何角色/资格拦截；studio 双角色（宁宁/夏目）数据契约均为 adult，天然全放行 |
| 互斥组 | 500 次采样，同掷内不出现互斥组冲突（§4.3 表逐条校验） |
| 撤销 | 连掷 3 次后逐次撤销，store 状态回到初始 |

回归门禁：`npm run test:unit` 需全绿；`node --test scripts/tests/test-random-prompt.js` 纳入 `scripts/tests/quality-test-inventory.js`。

## 10. 风险与边界

| 风险 | 缓解 |
| :--- | :--- |
| Krea2 随机标签 prose 化覆盖率不足 → 散文生硬 | 预检脚本统计覆盖率；采样器过滤不可 prose 化标签（v1 保守） |
| 随机结果与场景模板冲突（如室内场景抽到 `beach`） | 互斥表 + 写入 manualTags 时按场景模板 `templateKeys` 去重（已有逻辑） |
| 成人标签误入 | 评级联动即遮罩（唯一区分层）+ 采样器自身过滤 + 编译器 Krea 净化，无任何额外开关 |
| 随机污染用户正在编辑的状态 | 撤销快照（仅最近一组）+ 随机结果全部可见可手改 |
| 双人（triad）下随机服装语义 | triad 不抽通用服装，各自走官方服装/不注入服装 |
| 性能 | 采样器为纯数组操作（千级数据），无网络/IO；渲染仍走现有缓存路径 |

## 11. 实施分期

1. **P0（核心闭环）**：`randomPromptAssembler.ts` + `useRandomInspiration.ts` + 骰子按钮 + 单测。SD/Anima 全通，Krea2 走兜底。
2. **P1（体验补全）**：固定画师、撤销、toast 提示。
3. **P2（质量加固）**：Krea 覆盖率预检 + `*_REWRITES` 增量补词；`quality-test-inventory` 纳入回归。

每期完成后执行：`npm run typecheck:app && npm run test:frontend && npm run build`（沿用 plans/README 门禁）。

## 2026-09-18：词条分片与随机调用链修复

- 画师缺省候选由 `artistStyles.ts` 的轻量白名单派生，不加载完整展示目录。手动选择优先保留；仅本 composable 上一轮生成的画师可被重掷替换。用户通过画师选择器修改后，当前选择按手动选择保留；关闭随机画师后不继续保留随机注入项。
- 撤销恢复风格快照及随机画师归属；角色、场景、热门服装/蓝图或项目变化会使旧撤销失效，避免把上一创作对象的状态写到新对象上。
- 词条先按逗号拆分，再按规范化键按分类去重。同服装族/同时间段/同天气的描述可以叠加；不同族系在同一类别中消解。身体和官方服装分支同样执行身份排除与近景鞋袜过滤；泛化的局部特写没有目标部位，采用保守过滤，不改变用户显式手选词。
- 主镜头与主光照继续来自结构化控件。新增 Lighting/Camera 细节只从实际词库取值，并由 `randomPromptConstraints.ts` 中已评审的兼容表约束；不将所有光源、景别、视角混入一个随机池。扩词不自动等于进入随机候选；新增兼容规则须有可达性和冲突反例测试。
- `data/tags/manifest.json` 的 `dictionary` 显式登记存量重复词的 canonical/member IDs 与别名遮蔽决定。聚合保留所有旧 ID、分类与原始词条；字典选用明确的规范释义，不依赖分片排列顺序。新增重复、歧义别名、悬空 related、非法分类/数量/路径及符号链接会在写入前失败。
- 聚合与字典先完整校验并暂存；同步发布失败时恢复已替换文件。直接重建会作废两份产物的旧 `.gz/.br`，自愈入口随后刷新压缩。这是同步异常回滚，不宣称跨进程事务、并发读取隔离或断电一致性。

本批不更改定稿场景、人物与服装源数据、模型参数或本机/远程分级边界。自动化测试验证采样与编译契约，不代表真实模型画面、肢体或衣装效果已经通过视觉验收；真实出图与目标设备仍需另行取证。
