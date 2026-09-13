# 图片使用与裁切风险：源码复核

复核日期：2026-09-13。当前源码定向核对；未运行浏览器、未做本轮图片视觉审查、未修改业务代码。不能据此宣布 4K、双主题或实际裁切验收通过。对应 [JSON](gemini-crop-usage.json) 与本文由相同记录整理。

## 更正说明

- 撤销具体角色必定削顶、百分比裁切、黑块和面部像素过少的未实测结论。
- 补充角色目录资源分流、首页仅前 12 位与缺图未绑定 error 的边界。
- 撤销将当前图哈希直接登记到旧粒子文件的建议；字段存在不等于强校验。

## 角色目录头像

- 源码：`src/components/library/CharacterDirectory.vue`、`src/components/library/CharacterPortrait.vue`、`src/views/CharacterView.vue`、`src/utils/popularPortraitSource.ts`
- 已核对：目录把 item.image 传入 CharacterPortrait。CharacterView 对热门角色取 popularPortraitSrc 缩略图，对站内主角取 portrait.image。容器声明 48×60 CSS px；cover、center 20%、scale(1.2)、transform-origin center 20%，容器 overflow:hidden。
- 回退：src 缺失、含 portrait-pending 或图片 error 时显示名字首字；src 变化清除失败状态。
- 建议边界：cover 和放大可能截去内容边缘；仅作为待验证风险，不能由 CSS 判断具体角色帽子被切。
- 待验证：在目标视口中检查头像身份辨识与主体裁切；头像无需保证全身、被子或道具全部可见。

## 角色档案大立绘

- 源码：`src/views/CharacterView.vue`、`src/assets/css/character-view.css`
- 已核对：使用 current.portrait.image。图片 width:100%、height:auto、max-height:calc(100vh - 360px)、object-fit:contain；外层 flex 底部对齐。外层使用主题渐变与舞台底色，并非代码定义的纯黑背景。
- 回退：error 将角色加入 brokenPortraits，隐藏 img；徽章始终存在，并非错误时新切换的专用错误徽章。
- 建议边界：横幅素材可能与右侧档案形成较大的高度差；主题衬底、图片自带背景和实际留白需看渲染结果，不能直接判为黑块缺陷。
- 待验证：以横幅和竖幅各选样本，在深浅主题检查完整显示、背景过渡与错误后状态。

## 热门角色场景样张卡片

- 源码：`src/views/PopularSceneExplorerView.vue`
- 已核对：blueprint.characterId 与 selectedId 都存在时生成 /scene-showcase/thumbs/pc_${selectedId}_${blueprint.id}.jpg?v=...。容器 aspect-ratio:16/10、图片 cover、center 22%。样张加载失败时容器移除固定比例并显示提示；悬停与分级样式有额外变换。
- 回退：error 写入 thumbFailed，隐藏图片并显示“样张暂未就绪 · 可先查看场景”；thumbSrc 为空时不渲染这块 RouterLink。
- 建议边界：原始生成图与实际缩略图可能尺寸不同；没有核对最终缩略图和页面，不能根据历史截图推导具体帽子削顶或保留百分比。
- 待验证：核对请求成功的实际缩略图，记录角色、蓝图 ID、视口和主题，再判断构图裁切。

## 首页热门角色横条

- 源码：`src/views/HomeView.vue`、`src/assets/css/home.css`、`src/utils/popularPortraitSource.ts`
- 已核对：首页只渲染 popularCharacters.slice(0,12)。portraitSrc 使用 popularPortraitSrc 缩略图。卡片 flex-basis:140px，图片 width:100%、aspect-ratio:4/5、cover、center 22%；这些是 CSS 声明，不是物理屏幕像素实测。
- 回退：已登记 pending 角色由 helper 返回 portrait-pending.svg；本处 img 未绑定 error 回退，不能声称任意文件加载失败均有占位。
- 建议边界：人脸辨识度需当前前 12 位在实际渲染尺寸下复核；不统一强制裁成“面部 60%”，避免破坏不同角色构图。
- 待验证：确认前 12 位、pending 占位与缺文件三种情况；缺文件结果待浏览器验证。

## 人物点云场域

- 源码：`src/utils/particlePortrait.ts`、`src/components/visual/SemanticParticleField.vue`
- 已核对：portraitCloudUrl 取 /assets/particles/p_${encodeURIComponent(id)}.json；以 cloud.aspect 和网格映射绘制。sourceSha256 为可选来源字段；loadPortraitCloud 运行时检查 palette/grid 基本结构，没有读取源图做哈希比对。
- 回退：无 ID、pending、请求失败或基本结构不可用时返回 null；组件以 props.shape 创建几何形状。失败结果会缓存。
- 建议边界：缺少 sourceSha256 表示来源证据不足，不能直接证明视觉不同步。应核验历史构建来源或从确认的源图重建；不能把当前图片哈希补入旧点云，冒充生成来源。
- 待验证：来源无法恢复时保留未知；重建后保存真实来源与审核证据，并在页面检查轮廓。哈希字段数量不等于内容一致性通过。
