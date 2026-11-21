# 角色点阵粒子管线（操作手册）

角色粒子肖像由原图离线生成点云。页面入口：`src/views/PopularSceneExplorerView.vue`，渲染器：`src/components/visual/SemanticParticleField.vue`，调色板工具：`src/utils/particlePortrait.ts`。

> 完整角色接入见 [热门角色接入工作流](character-onboarding-workflow.md)，视觉表现规范见 [DESIGN.md](../../../DESIGN.md)。

---

## 1. 首次准备依赖

```powershell
pip install numpy pillow
# 国内镜像备选：
pip install -i https://pypi.tuna.tsinghua.edu.cn/simple numpy pillow
```

> 整图点云采样纯基于 `numpy` + `Pillow` CPU 运算（秒级），无需 `rembg` 或 GPU。

---

## 2. 新增角色点云（3 步，前端零改动）

1. **放源图**：放置至 `assets/characters/popular-<角色id>.png`（推荐 `832×1216` 竖图；工作室角色宁宁/夏目图名映射见脚本内 `STUDIO_PORTRAITS`）。
2. **生成点云 JSON**：
   ```powershell
   npm run particles:build                # 全量生成
   npm run particles:build -- rem_rezero  # 指定单个角色
   ```
   产物输出至 `assets/particles/p_<角色id>.json`（约 100 KB/角色）。
3. **核对交付状态**：前端按 `data/popular-onboarding.json` 的 `portraitPending` 懒加载；仍为 `pending` 时不请求点云并回落 `characterParticleTheme` 抽象形状，须确认真实立绘与缩略图后再解除 `pending`。

---

## 3. 核心参数与双主题绘制策略

### 离线生成常量
| 常量 | 默认值 | 说明 |
| --- | --- | --- |
| `SOURCE_WIDTH` | `200` | 源网格宽（px），消除前端 ≤ ~110×160 点阵混叠 |
| `PALETTE_SIZE` | `36` | k-means 主色数（base36 索引上限） |
| `FEATHER_RATIO` | `0.05` | 边缘羽化比例（过大易产生碎拼图感） |

### 渲染与浅色主题可读性
- **前端物理与点径**：点数下限 hero `8000` / ambient `6000`；点径比 `0.3 × 点距`；斥力半径 `105px`，回流速度 `0.01`。
- **深色主题**：采用 `screen` 混合（暗部隐入底色、亮部自然发光）。
- **浅色主题**（`shouldUnderlay` + `SemanticParticleField.draw` + `lightPortraitColor`）：
  - 采用 `source-over`（主点透明度 `0.95`）与保留色相的调色板，暗部天然显形。
  - **极亮色阴影界定**（亮度 `> 0.72`）：仅对主粒子绘制右下偏移阴影（`0.5px` 偏移、`1.15×` 半径、`#565b68` 0.42 alpha），避免白发/白衣融入浅底或生成灰边；`ambient` 逸散粒子不加衬影。

---

## 4. 常见问题

- **新角色仍显示抽象形状**：检查 `/assets/particles/p_<id>.json` 是否 404，或 `portraitPending` 是否尚未清除。
- **桌面端未同步**：执行根目录 `deploy-desktop.bat` 同步资产，见 [桌面部署](../../desktop-deployment.md)。
- **参数微调**：修改脚本常量后执行 `npm run particles:build -- <id>` 刷新页面即可，无需改前端代码。
