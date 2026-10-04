# 项目内容维护

人物、服装、场景和蓝图现在以记录维护，工作数据保存在运行目录的 content/catalog.sqlite。data/catalog/ 是逐条导出的项目快照，用于 Git 审查与发行初始化。详细边界见 [内容库设计](architecture/CONTENT-CATALOG-DESIGN.md)。

## 日常编写

进入“更多 → 内容维护”，选择人物、服装、场景或蓝图。目录提供搜索、角色/分类/分级筛选和分页；点选记录后才读取完整内容。

1. 编辑表单，点击“保存更改”直接保存当前内容。未展示的扩展字段原样保留，需要时展开“完整数据与扩展设置”。
2. 可以继续编辑其他记录；关联人物、默认服装和蓝图可以合批保存。
3. 需要合批时点击“暂存修改”；“查看修改”展示前后内容和标签/归档的连带修改。
4. 点击“保存更改”写入工作内容库，修订历史与记录一起提交。

保存失败或冲突会保留草稿。不同记录的修改可独立合并；同一记录发生冲突时比较当前内容，合并后明确采用当前修订号，再加入修改。重新打开草稿不会自动把旧内容绑定到新的修订号。

服装记录键由角色 ID 与服装 ID 组成，已有 ID 不改名；原角色的固定 LoRA 控制配方仍属于程序配置。工作室场景使用 scNNN，新增时提供未预留的候选编号；并发占用会被拒绝。下架保留历史和身份，不能复用编号。

## 标签、推荐和图片

“标签与推荐”提供分页标签编辑和推荐顺序；标签重命名/删除同步调整场景标签。已有重复词与别名通过明确的字典策略消歧，新冲突不能静默选边。

“角色立绘”和“样张与封面”使用本机图片维护与资源事务。“样张与封面”可直接进入，按标题、类型、角色和分级筛选，每页读取 24 条摘要；选中缩略图后即可上传或替换，不需要先打开内容编辑。蓝图按角色与蓝图 ID 组合绑定样张，图片路径以当前样张清单为准。选择新图片后自动保存原图和缩略图，旧图片自动备份。

“首页封面”显示宁宁、夏目的实际封面和来源，可分别替换或恢复内置图。成人样张默认模糊，仅本机可主动开启查看。选图保留其他缩略图的缓存地址，替换只更新目标图片；图片工具按需加载。参考图审核、发布、pending 与资源访问限制均沿用原流程。

“文件与备份”检查数据库结构和内容关联，也可以查看图片事务备份。记录详情的修订历史可恢复到编辑表单，保存后生成新的修订。检查通过不代表真实画面或设备验收。

## 批量修改与快照

批量页面可导入带修订号的变更文件，也可预览和导入完整内容快照。导入比较原始种子、本地修改和新内容；冲突拒绝写入，缺失记录不隐式删除。

开发维护入口：

    npm run wf -- content:catalog query --root E:/code/2/lora/AI-CG-Studio --runtime-root E:/code/2/lora/AI-CG-Studio/runtime --kind blueprint --character typhon_arknights
    npm run wf -- content:catalog patch --root E:/code/2/lora/AI-CG-Studio --runtime-root E:/code/2/lora/AI-CG-Studio/runtime --file patch.json

`--root` 默认当前项目目录，`--runtime-root` 始终显式指定实际工作库。读取完整内容无需直接查询 SQLite：

    npm run wf -- content:catalog character --runtime-root <实际运行目录> --character typhon_arknights
    npm run wf -- content:catalog record --runtime-root <实际运行目录> --kind outfit --id typhon_arknights/standard
    npm run wf -- content:catalog history --runtime-root <实际运行目录> --kind outfit --id typhon_arknights/standard

`character` 返回人物、服装与关联场景/蓝图的完整记录快照，包含各自修订号；可保存为编写前基线。`record --revision 2` 读取具体历史内容。`query` 支持 `--sort newest`、`--page`、`--page-size` 及 `--created-from` / `--created-to`；创建时间范围使用带时区的 RFC3339，起点包含、终点不包含，未知时间不混入日期筛选。

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

已迁移记录的未知创建时间，可用 `{ "kind": "character", "id": "角色ID", "expectedRevision": 2, "createdAt": "有证据的RFC3339时间" }` 单独补录，仍经过预览、修订冲突及历史记录；已有时间不能重写。禁止用本次导入或编辑时间冒充新增时间。

项目内容发布前显式导出：

    npm run wf -- content:catalog export --root E:/code/2/lora/AI-CG-Studio --runtime-root E:/code/2/lora/AI-CG-Studio/runtime --out E:/code/2/lora/AI-CG-Studio/data/catalog

审查逐条快照后再提交和构建。导出文件不包含其他机器完整的本机修订历史。升级包不会自动覆盖个人工作库；导入新快照须明确执行。

局部交付使用选择器，避免把其他个人内容带入项目快照：

    npm run wf -- content:catalog export --runtime-root <实际运行目录> --out data/catalog --character typhon_arknights --character shu_arknights
    npm run wf -- content:catalog export --runtime-root <实际运行目录> --out data/catalog --record blueprint:typhon_arknights_behemoth_hunt_bow --record outfit:typhon_arknights/standard

存在目标快照时只合并选中记录，范围外记录保持目标原值，选中下架记录转入 retired。新目录只保存所选范围，适合作为编写基线或导入包，不能代替完整备份。没有选择器时沿用全库导出。

改写验收可直接读取这些记录快照，按角色及 SFW 缩小范围，同时导出真实编译文本：

    npm run wf -- check:rewrite --delivery <改写后快照目录> --baseline-file <编写前快照目录或JSON> --character typhon_arknights --sfw --compiled-out runtime/typhon-prompts.json

未指定 delivery 时读取当前项目 data/catalog；默认 Git 基线为 HEAD，优先读取该提交的记录快照，迁移前提交才使用旧分片。`--ids` 可精确选择蓝图/场景，`--targeted` 继续用于单点纠错。编译出口适用于热门角色蓝图，使用当前 Anima/Krea profile、实际服装绑定与导演参数；只输出文本，不调用模型。词条、官方衣装及真实画面仍需对应资料或人工核对。

## 迁移与保护

首次启动优先读取项目快照；旧安装没有快照时从现有个人数据分片导入。原始 ID、提示词、分级、服装绑定和扩展字段保持原值，未知创建时间保留为空。启用标记存在而数据库缺失时停止读取，不能用内置内容静默覆盖。

旧分片和聚合回写入口不再用于已经迁移的项目。构建工具读取 data/catalog/，不能把手改旧 JSON 当作新内容交付。

data/prompt-pinned-scenes.json 继续受保护。批量修改跳过保护字段；单条定稿调整仍先真实出图，再用 scenes:pin-capture 维护基线。普通记录保存只能保持保护字段原值，或与已验证的新基线完全一致。模型调用数量、费用与安装均服从用户授权。

所有内容管理接口仅供本机访问。远程共享继续要求独立审核、分级和字节绑定；内容变化不会继承旧发布的可服务资格。
