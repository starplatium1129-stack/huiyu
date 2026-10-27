# 项目内容维护手册

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

---

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

### 批量 Patch 更新
编写 JSON 补丁文件 `patch.json`：
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
npm run wf -- content:catalog patch --runtime-root <运行目录> --file patch.json

# 2. 实际应用
npm run wf -- content:catalog patch --runtime-root <运行目录> --file patch.json --apply
```

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

## 4. 数据保护红线

1. **定稿场景保护**：`data/prompt-pinned-scenes.json` 为字节级基线保护文件。批量修改一律跳过；单条修改必须先真实出图验证，再执行 `npm run scenes:pin-capture -- --id=<场景ID>` 更新基线。
2. **用户数据保留**：桌面升级与素材导入始终采用 `--preserve-local`，绝不静默覆盖用户的自定义修改。
