# 项目内容维护手册

<a id="文件职责"></a>

人物、服装、场景和蓝图均采用记录化管理：
- **工作权威**：运行时个人目录下的 `content/catalog.sqlite`。
- **项目快照**：Git 跟踪的 `data/catalog/`（用于审查、版本控制与发布打包）。

---

## 1. 界面日常维护

打开桌面端进入 **“更多” $\to$ “内容维护”**：
1. **浏览与筛选**：选择人物、服装、场景或蓝图，支持关键词搜索、角色/分类/分级筛选。
2. **编辑与暂存**：修改表单内容后可单条“保存更改”，或多项合批暂存后批量保存。
3. **标签与推荐**：提供标签重命名、词典映射（Gelbooru 优先标签标准与别名映射）和推荐顺序配置。
4. **样张与封面**：按标题、角色和分级筛选，直接上传或替换样张原图与缩略图，系统会自动备份旧图片。

新增绘图角色时选“接入绘图角色”，填写身份与首套服装后一次保存两条关联记录；保存完成可直接继续创建该角色的蓝图。立绘未完成时使用现有待补素材，不填写不存在的图片路径。

角色编辑中的“日常圈子”维护 `profile.identity.region`（档案出身地）、`race`（种族）、`school`（学院）及 `classificationSource`（出处）。关系页按作品已有分类展示圈子，缺失资料归入“待整理”；同组不会自动生成剧情关系，归属不从阵营散文或图像标签推断。

搜索使用包含匹配：三个及以上字符可由 SQLite 派生索引加速，最终仍核对完整关键词。索引随写入维护，内容缓存按修订失效；历史修订不会自动清理。

成片下的“保存为场景”使用提交时冻结的角色、服装、提示词和参数；填写名称、画面说明并选择分级后保存，分级只升不降。工作室角色写入场景库，热门角色写入对应蓝图库，样张上传失败可单独重试。来源配方保留原始信息，重新选择时按当前规则编译，不保证与原图完全相同。

角色档案的“更换立绘”使用本机维护入口：上传 PNG、JPEG 或 WebP 后，在个人运行目录生成原图、头像和粒子点阵并原子切换版本。最大 15 MiB、边长 8192、3200 万像素；失败保留旧形象，恢复内置不会删除旧版本。远程继续使用内置资源，样张、参考库和 Live2D 各走自己的入口。

---

<a id="批量修改与快照"></a>

## 2. 命令行维护与批量补丁

通过工作流命令直接查询或操作 SQLite 内容库，无需手动操作数据库：

### 查询记录
```powershell
# 查询某角色的全部数据（人物、服装、场景、蓝图）
npm run wf -- content:catalog character --runtime-root <运行目录> --character <角色ID>

# 查询特定记录
npm run wf -- content:catalog record --runtime-root <运行目录> --kind outfit --id <角色ID/服装ID>

# 查看历史修订版本
npm run wf -- content:catalog history --runtime-root <运行目录> --kind outfit --id <角色ID/服装ID>
```

### AI 创作上下文

先用 `stats` 核对回执中的工作库路径，再读取精简的角色上下文：
```powershell
npm run wf -- content:catalog authoring --runtime-root <运行目录> --character <已有角色ID>
# 新角色须显式指定目标 ID 和一位已有角色作为结构参考；不会创建记录
npm run wf -- content:catalog authoring --runtime-root <运行目录> --character <新角色ID> --example <参考角色ID>
# 工作室场景：不带 ID 返回下一个可用编号，带 ID 返回该场景及定稿保护字段
npm run wf -- content:catalog authoring --runtime-root <运行目录> --kind scene
npm run wf -- content:catalog authoring --runtime-root <运行目录> --kind scene --id <场景ID>
```
角色回执包含目标的 `expectedRevision`、完整的人物与服装记录，以及至多 100 条蓝图的 ID、标题、服装和修订号；超过 100 条会明确标记截断，继续用 `query` 分页。场景回执包含当前完整记录或下一个可用 ID，并标明定稿字段保护。参考角色的数据只作结构上下文，新角色需逐字段写自己的身份、服装与画面内容。修改既有蓝图时再用 `record --kind blueprint --id <ID>` 读取完整提示词及当前修订。补丁放在被忽略的 `runtime/`，先执行下方 `patch` 预览，核对编译内容与需要的真实画面后再写入并定向导出项目快照。

人物档案的 `profile.name/source/speech/visual_dna.signature/portrait.image` 必须为非空字符串，`profile.traits` 沿用至少三项非空识别词条的契约，支持字符串或已有的含 `tag/label` 的对象。`speech` 是可直接使用的开场台词，不接收 `{intro,touch,special}` 对象；来源从真实作品信息填写，识别词条取该人物已有外貌锚点。界面保存、CLI 补丁和导入均在写入前核对这些字段；立绘未制作时使用项目自带的 `../assets/characters/portrait-pending.svg`，不把待产素材当成已有资产。

### 批量 Patch 更新
在被忽略的 `runtime/` 中编写 JSON 补丁文件，例如 `runtime/patch.json`：
```json
{
  "changes": [
    {
      "kind": "blueprint",
      "id": "blueprint_id",
      "expectedRevision": 1,
      "patch": { "title": "新标题", "location": "新地点" }
    }
  ]
}
```
预览并应用更新：
```powershell
# 1. 预览补丁（只读）
npm run wf -- content:catalog patch --runtime-root <运行目录> --file runtime/patch.json

# 2. 实际应用
npm run wf -- content:catalog patch --runtime-root <运行目录> --file runtime/patch.json --apply
```

### 提示词写入检查

界面保存、CLI `patch` 及快照导入共用事务内的提示词检查。明确的未替换占位符、模型输入中的检索标签、热门角色中的工作室专用控制词、身份／服装词条中的环境污染，以及普通蓝图负向中的通用质量／解剖模板会拒绝整批写入，并返回记录、字段和规则代码。蓝图只保存画面专属排除项，无此需求时 `negativeTokens` 为 `[]`；已有成片冻结的生成配方含模型完整负面，保留其来源契约。检查仅针对本次改变的源字段及绑定；未改提示词的元数据整理不会被历史提示词问题阻塞，定稿字段仍按原字节基线处理。

画面字段重复模型层配方、正负向同词等需结合意图判断的问题只返回建议，在修改预览和保存回执中展示。`authoring` 回执的 `promptPolicy` 公布当前规则及检查边界；这不是对整个 skill 的智能语义认证，不设置字数或标签数配额，不自动改写提示词，也不替代最终编译与真实画面复核。

蓝图的 `adult` 决定生成内容模式，`sampleRating` 只描述已有样张；两者独立编辑，修改样张分级不会改变服装注入或扩展提示词。

---

## 3. 导出与快照同步

在提交 Git 或打包发布前，将 SQLite 工作库中的修改显式导出为 `data/catalog` 快照：

项目快照构建会检查档案中指向 `assets/characters/` 的本地立绘文件；素材尚未完成时使用现有的 `portrait-pending.svg`，不要填写尚不存在的图片地址。

先用 `content:catalog stats --runtime-root <实际运行目录>` 核对回执中的 `source.database`。项目的 `runtime` 与已安装桌面端的个人运行目录是不同的工作库，不能凭目录名称或相同角色 ID 判断它们已经同步。

### 全量备份（使用新目录）
```powershell
npm run wf -- content:catalog export --runtime-root <运行目录> --out runtime/catalog-backups/<新的备份编号>
```

全库导出不能覆盖已有目录。日常新增、编辑只导出本次涉及的记录或角色；不以整库导出代替两份工作库之间的内容合并。

### 定向导出特定角色（推荐）
避免把本地无关的个人修改混入公共提交：
```powershell
npm run wf -- content:catalog export --runtime-root <运行目录> --out data/catalog --character firefly_hsr

# 只更新一条蓝图
npm run wf -- content:catalog export --runtime-root <运行目录> --out data/catalog --record blueprint:<蓝图ID>
```

已有记录只有在目标内容属于当前工作库的已知历史或默认基线时才能被替换；来源冲突会在发布前拒绝，不提供跳过保护的强制覆盖参数。先比较双方内容，在正确工作库中合并保存，再重新导出。导出中发生实际变化的项目记录采用高于目标的发布修订，避免个人库本机计数较低导致下次升级误判；工作库保存仍使用 `record` 读取的本机修订。未修改记录保留原字节，导出使用同目录互斥与目标变更核对；失败时清理本次临时目录，发布成功后的清理异常会保留备份并明确提示。

`import --preserve-local` 继续保留个人修改，并额外拒绝低于已接收上游修订、同修订异内容或更新时间回退的快照。这里比较的是先前接收的上游基线，不是不同工作库的本机修订号。项目构建和桌面同步也会拒绝与 `data/prompt-pinned-scenes.json` 不一致的定稿文档快照。

---

<a id="迁移与保护"></a>

## 4. 迁移与数据保护

旧分片与 `legacy:*` 仅用于支持范围内的未迁移资料；已启用记录库或项目快照时使用 `content:catalog`，不回写旧分片。具体旧入口先查看工作流帮助及其写入范围。

1. **定稿场景保护**：`data/prompt-pinned-scenes.json` 为字节级基线保护文件。批量修改一律跳过；单条修改必须先真实出图验证，再执行 `npm run scenes:pin-capture -- --id=<场景ID>` 更新基线。
2. **用户数据保留**：桌面升级与素材导入始终采用 `--preserve-local`，绝不静默覆盖用户的自定义修改。
