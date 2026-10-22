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

### 全量导出
```powershell
npm run wf -- content:catalog export --runtime-root <运行目录> --out data/catalog
```

### 定向导出特定角色（推荐）
避免把本地无关的个人修改混入公共提交：
```powershell
npm run wf -- content:catalog export --runtime-root <运行目录> --out data/catalog --character firefly_hsr
```

---

## 4. 数据保护红线

1. **定稿场景保护**：`data/prompt-pinned-scenes.json` 为字节级基线保护文件。批量修改一律跳过；单条修改必须先真实出图验证，再执行 `npm run scenes:pin-capture -- --id=<场景ID>` 更新基线。
2. **用户数据保留**：桌面升级与素材导入始终采用 `--preserve-local`，绝不静默覆盖用户的自定义修改。
