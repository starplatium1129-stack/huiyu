# 界面文案：六条建议的源码复核

复核日期：2026-09-13。当前源码定向核对；未运行浏览器、未做本轮图片视觉审查、未修改业务代码。不能据此宣布 4K、双主题或实际裁切验收通过。对应 [JSON](gemini-ui-copy-review.json) 与本文由相同记录整理。

六条中：1 条确认文案与只读状态不匹配，4 条可选建议，1 条撤销。建议不是自动修改授权或缺陷硬门禁。

## 更正说明

- 撤销作品库无入口误报；标签入口实际为禁用而非不存在。
- 入口命名与服务层级保留为可选建议，不列为缺陷硬门禁。
- 错误文案不推断未挂载、待生成或不存在的导入操作。

## COPY-01 · withdrawn

- 文件：`src/views/GalleryView.vue`
- 定位：`v-else-if="!history.length"`
- 已核对：空态内已存在 RouterLink to="/prompt-builder"，文字“开始绘制”。
- 出现条件：作品库加载成功且 history 为空时。
- 处理意见：撤销“无可点击入口”和新增按钮建议；本轮未验证按钮的实际可见性。

## COPY-02 · confirmed-copy-mismatch

- 文件：`src/views/SceneManagerView.vue`
- 定位：`没有匹配的标签`
- 已核对：标签筛选无结果提示“调整筛选条件，或新建一个标签。”；desktopPackaged 时“新增标签”按钮仍存在但 disabled。
- 出现条件：加载成功、标签页、filteredTags 为空且 desktopPackaged 为 true。
- 处理意见：只读状态可改为“没有匹配的标签，请调整筛选条件。”；开发工作区可保留新建建议。

## COPY-03 · optional-suggestion

- 文件：`src/views/SceneManagerView.vue`
- 定位：`场景档案读取失败`
- 已核对：错误文案附加“请确认通过 localhost 访问且文件存在。”；同一错误面板已有“重新读取”按钮。
- 出现条件：!loading && loadError，不等同于已诊断出文件缺失或服务停止。
- 处理意见：按使用环境调整指引；桌面可用“场景资料暂时无法读取，请点击重新读取。”并保留错误详情供排查。不用“本地网关”替换 localhost，也不推断根因。

## COPY-04 · optional-suggestion

- 文件：`src/views/CharacterView.vue`
- 定位：`看原型场景`
- 已核对：标题为“角色档案”，上方标识“角色资料库”；热门角色按钮“看原型场景”指向 /prompt-builder?popular=...，主角“看核心场景”指向 /scene-explorer?character=...。
- 出现条件：当前角色可用时，isPopular 控制标签和目的地。
- 处理意见：这是信息层级与入口命名的可用性建议，不是同一功能名称必然错误。若调整，需尊重两个目的地差异并做用户理解验证，不直接统一成相同入口。

## COPY-05 · optional-suggestion

- 文件：`src/views/ControlView.vue`
- 定位：`control-overview / service-row-meta`
- 已核对：连接概览显示已连接/未连接/待检测；资源区 WebUI、ComfyUI 行显示受控/手动/未运行，语音显示在线/未运行。两类状态位于不同区域，连接卡也含 detail。
- 出现条件：服务轮询状态进入相应条件分支时；未核验真实服务。
- 处理意见：如用户难理解，可补充“连接状态”和“启动方式”标签。不能把连接与进程管理视为同一维度错误，也不能给没有管理归属数据的服务推断“外部手动启动”。

## COPY-06 · optional-suggestion

- 文件：`src/views/CharacterView.vue / src/views/PopularSceneExplorerView.vue`
- 定位：`参考图暂时无法读取 / 样张暂未就绪`
- 已核对：参考卡已有无 URL 的“待生成”与 URL 加载失败的“本机暂无参考图”分支；灯箱有加载失败回退。样张文案由图片 error 触发。
- 出现条件：分别是无 URL、图片加载失败、灯箱回退或样张图片 error，不能合并成未安装资源包这一根因。
- 处理意见：保留不确定性，例如“样张暂时无法读取 · 可先查看场景”。撤销“本机未挂载参考素材库（可通过外部存储导入）”和“基础预览待生成”，因为现有错误信号不能证明这些原因或导入能力。
