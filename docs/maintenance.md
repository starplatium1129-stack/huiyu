# 项目内容维护手册

人物、服装、场景和蓝图均采用记录化架构管理：
- **工作权威**：开发环境固定使用 `runtime/content/catalog.sqlite`（维护命令传 `--runtime-root runtime`）；已安装桌面端使用个人目录下的 `content/catalog.sqlite`。
- **项目快照**：Git 跟踪的 `data/catalog/`（用于审查、版本控制与发布打包）。

---

## 1. 界面日常维护

打开桌面端，进入 **“更多” → “内容维护”**：
1. **浏览与筛选**：查看人物、服装、场景与蓝图，支持关键词与分类/分级筛选。
2. **编辑与暂存**：支持单条保存或多项合批暂存后批量保存。
3. **标签与别名**：支持标签重命名与别名字典映射（基于 Gelbooru 规范）。
4. **样张与封面**：支持上传/替换样张原图与缩略图，系统自动备份旧图片。
5. **保存成片为场景**：在成片菜单点击“保存为场景”，冻结当前参数与配方，选择分级后保存。

---

## 2. 命令行维护与批量更新

通过工作流命令直接读写 SQLite 内容库：

### 查询与上下文
```powershell
# 查询某角色的全部数据（人物、服装、场景、蓝图）
npm run wf -- content:catalog character --runtime-root <运行目录> --character <角色ID>

# 查询特定记录
npm run wf -- content:catalog record --runtime-root <运行目录> --kind outfit --id <角色ID/服装ID>

# 查看历史修订
npm run wf -- content:catalog history --runtime-root <运行目录> --kind outfit --id <角色ID/服装ID>

# 读取 AI 创作上下文（返回 revision、服装与蓝图索引）
npm run wf -- content:catalog authoring --runtime-root <运行目录> --character <角色ID>

# 工作室场景：返回下一个可用编号或指定场景保护字段
npm run wf -- content:catalog authoring --runtime-root <运行目录> --kind scene [--id <场景ID>]
```

### 批量 Patch 更新
在被忽略的 `runtime/` 下编写 JSON 补丁（如 `runtime/patch.json`）：
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

执行更新：
```powershell
# 1. 预览补丁（只读）
npm run wf -- content:catalog patch --runtime-root <运行目录> --file runtime/patch.json

# 2. 实际应用
npm run wf -- content:catalog patch --runtime-root <运行目录> --file runtime/patch.json --apply
```

### 提示词校验规则

- 服装记录描述衣物本身的颜色、材质、剪裁和配饰。地点、天气、时段、光源和全画面色调写入场景、蓝图或导演设置，换装时继续沿用当前画面设置。
保存或打补丁时会自动执行提示词校验：
- **拒绝规则**：未替换的占位符、模型输入残留的检索标签、热门角色混入的工作室专用词、身份/服装词中的环境污染，均会拒绝整批写入。
- **负面词规范**：蓝图仅保存专属排除项，无专属排除时 `negativeTokens` 为空数组 `[]`。

---

## 3. 导出与快照同步

在提交 Git 或打包发布前，将 SQLite 工作库的变动导出为 `data/catalog/` 快照：

### 定向导出特定角色（推荐）
避免把无关的本地个性化修改混入提交：
```powershell
# 导出指定角色全部记录
npm run wf -- content:catalog export --runtime-root <运行目录> --out data/catalog --character <角色ID>

# 仅导出单条蓝图
npm run wf -- content:catalog export --runtime-root <运行目录> --out data/catalog --record blueprint:<蓝图ID>
```

### 全量备份
```powershell
npm run wf -- content:catalog export --runtime-root <运行目录> --out runtime/catalog-backups/<备份编号>
```

---

## 4. 迁移与数据保护

1. **定稿场景保护**：`data/prompt-pinned-scenes.json` 为字节级基线保护文件。批量修改一律跳过；单条修改必须先真实出图验证，再执行 `npm run scenes:pin-capture -- --id=<场景ID>` 更新基线。
2. **用户数据保留**：桌面升级与素材导入始终采用 `--preserve-local`，增量合并更新，绝不静默覆盖用户的自定义修改。
