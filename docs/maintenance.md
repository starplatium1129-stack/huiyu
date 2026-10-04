# 项目内容维护

人物、服装、场景和蓝图现在以记录维护，工作数据保存在运行目录的 content/catalog.sqlite。data/catalog/ 是逐条导出的项目快照，用于 Git 审查与发行初始化。详细边界见 [内容库设计](architecture/CONTENT-CATALOG-DESIGN.md)。

## 日常编写

进入“更多 → 内容维护”，选择人物、服装、场景或蓝图。目录提供搜索、角色/分类/分级筛选和分页；点选记录后才读取完整内容。

1. 编辑表单，点击“加入待保存修改”。未展示的扩展字段原样保留，需要时使用高级字段。
2. 可以继续编辑其他记录；关联人物、默认服装和蓝图可以合批保存。
3. 点击“影响预览”查看前后内容和标签/下架的连带修改。
4. 点击“保存”写入工作内容库，修订历史与记录一起提交。

保存失败或冲突会保留草稿。不同记录的修改可独立合并；同一记录发生冲突时比较当前内容，合并后明确采用当前修订号，再加入修改。重新打开草稿不会自动把旧内容绑定到新的修订号。

服装记录键由角色 ID 与服装 ID 组成，已有 ID 不改名；原角色的固定 LoRA 控制配方仍属于程序配置。工作室场景使用 scNNN，新增时提供未预留的候选编号；并发占用会被拒绝。下架保留历史和身份，不能复用编号。

## 标签、推荐和图片

“标签与策展”提供分页标签编辑和策展顺序；标签重命名/删除同步调整场景标签。已有重复词与别名通过明确的字典策略消歧，新冲突不能静默选边。

“角色图片”“样张与首页图”继续使用原有本机图片维护与资源事务。选择场景或蓝图后可替换其样张；首页图可独立替换或恢复内置版本。参考图审核、发布、pending 与资源访问限制均沿用原流程。

“维护工具”检查数据库结构和内容关联，也可以查看图片事务备份。记录详情的修订历史可恢复到编辑表单，保存后生成新的修订。检查通过不代表真实画面或设备验收。

## 批量修改与快照

批量页面可导入带修订号的变更文件，也可预览和导入完整内容快照。导入比较原始种子、本地修改和新内容；冲突拒绝写入，缺失记录不隐式删除。

开发维护入口：

    npm run wf -- content:catalog query --root E:/code/2/lora/AI-CG-Studio --runtime-root E:/code/2/lora/AI-CG-Studio/runtime --kind blueprint --character typhon_arknights
    npm run wf -- content:catalog patch --root E:/code/2/lora/AI-CG-Studio --runtime-root E:/code/2/lora/AI-CG-Studio/runtime --file patch.json

字段补丁只需写本次修改：

    {
      "changes": [
        {
          "kind": "blueprint",
          "id": "existing_blueprint_id",
          "expectedRevision": 1,
          "patch": { "title": "新标题", "location": "已确认的地点" }
        }
      ]
    }

patch 可递归更新对象，数组完整替换，显式 null 保留为 null；不得同时提交 patch 与完整 data。新增记录使用 expectedRevision 0 和完整 data，下架使用 remove true。预览后在同一命令加 --apply 写入。

项目内容发布前显式导出：

    npm run wf -- content:catalog export --root E:/code/2/lora/AI-CG-Studio --runtime-root E:/code/2/lora/AI-CG-Studio/runtime --out E:/code/2/lora/AI-CG-Studio/data/catalog

审查逐条快照后再提交和构建。导出文件不包含其他机器完整的本机修订历史。升级包不会自动覆盖个人工作库；导入新快照须明确执行。

## 迁移与保护

首次启动优先读取项目快照；旧安装没有快照时从现有个人数据分片导入。原始 ID、提示词、分级、服装绑定和扩展字段保持原值，未知创建时间保留为空。启用标记存在而数据库缺失时停止读取，不能用内置内容静默覆盖。

旧分片和聚合回写入口不再用于已经迁移的项目。构建工具读取 data/catalog/，不能把手改旧 JSON 当作新内容交付。

data/prompt-pinned-scenes.json 继续受保护。批量修改跳过保护字段；单条定稿调整仍先真实出图，再用 scenes:pin-capture 维护基线。普通记录保存只能保持保护字段原值，或与已验证的新基线完全一致。模型调用数量、费用与安装均服从用户授权。

所有内容管理接口仅供本机访问。远程共享继续要求独立审核、分级和字节绑定；内容变化不会继承旧发布的可服务资格。
