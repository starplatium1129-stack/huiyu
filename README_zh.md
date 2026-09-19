# 绘遇 · HUIYU

[下载 Windows 桌面版 1.7.1（手动安装）](https://github.com/starplatium1129-stack/huiyu/releases/tag/v1.7.1) · [查看更新说明](docs/releases/v1.7.1.md)

> 从故事出发，把想画的瞬间整理成可以直接生成的 Galgame 风格 CG、4 视角角色参考档案与 AI 叙事短片。

[English](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

当前规模与能力边界见 [项目状态](docs/project-status.md)，硬件要求与模型下载见 [全功能开箱指南](docs/guides/setup-and-models.md)，后续事项见 [未来规划](docs/roadmap.md)。

## 项目定位

绘遇 HUIYU (Lingji Atelier) 是我为个人创作整理的一套本地工具，平时自己使用，也会临时分享给身边的朋友。它不是公开运营的平台，也不提供账号、社区、商店或云端同步。

系统支持专属主角 **绫地宁宁** 与 **四季夏目**，以及持续扩展的动漫、游戏角色与服装。项目会把故事、角色、情绪、镜头、构图、光照和出图参数放在同一个 Scene 中，减少从空白 Prompt 开始反复试错的时间。规模和待补资产只在[项目状态](docs/project-status.md)维护。

这是非官方、非商业的个人爱好项目，与原作及相关权利方没有隶属或授权关系。

## 现在能做什么

- **丰富的场景库与热门角色体系**：
  - 浏览场景、蓝图与审核样张，按角色、分类、季节和内容分级筛选。
  - 多部动漫、游戏作品的角色档案，支持专属服装与场景选择。
  - 在“效果样张”中查看逐场景审核的实际成图，支持带着场景直接进入导演台。
- **角色 4 视角参考档案库（Character Reference Bible）**：
  - 四种电影参考视角与正、侧、背三视图设计基线；登记、待生成、已有图片与视觉审核完成分开统计，详见[项目状态](docs/project-status.md)。
  - 新角色形态先经 `workflow reference:register` 登记占位（不制造断链），再由 `reference:render` 出图回填。
  - 全自动闭环自愈流水线：3 并发批量出图池 + 4 并发 Gemini 3.7 Flash 纯视觉审核池 + 定向微调自愈引擎。
  - 标准化参考资产契约为下游 MiniMax H3 Ref2VA 视频生成提供稳定的角色锁脸保障。
- **多生成引擎协同与 精选动漫画风**：
  - 跨引擎提示词自动编译：支持 Stable Diffusion / WAI (Danbooru tags)、Anima 1.1 (`@artist` + 原生标签流) 与 Krea 2 Turbo (3~5 句纯英文自然语言)。
  - 内置精选动漫画风与作监级风格（如猫富ちゃお/动画工房、浅野恭司/WIT Studio、Rella 星夜月光、深崎暮人、So-bin 等）。
  - 在 reForge 环境中自动增强双人构图：Regional Prompter 分离提示词区域，逐场景 OpenPose 稳定站位。
- **AI 叙事视频工作台（Video Studio）**：
  - 本地 AI 视频生成支持 Wan 2.2 TI2V 与 MiniMax H3（Ref2VA 多模态参考图绑定）。
  - 剧本智能分镜拆解、画风锚注入、中日英对白语言显式控制（`dialogueLang: auto/zh/ja/en`）与 Range 流式播放。
- **角色房间与语音交互**：
  - 本地角色房间连接 Ollama 或兼容 API 进行流式文字聊天；句子级语音流水线边生成、边翻译、边合成（GPT-SoVITS）。
  - Live2D 立绘随真实语音振幅对口型、随情感切换表情零件。
  - 控制面板提供显存资源调度：绘图优先 / 聊天优先一键切换，模型按需卸载。
- **桌面端伴侣（Tauri 2）**：
  - 轻量 Tauri 2 桌面端（Companion + Atelier 双窗口、托盘、Native Live2D overlay），支持增量极速部署流水线（`deploy-desktop-quick.ps1`）。

## 安装

### 环境要求

| 组件 | 必需 | 说明 |
| :--- | :---: | :--- |
| Node.js | **是** | `>= 22.18`（npm 11.x），用 `node -v` 确认 |
| Windows | **是** | 主要使用环境；启动器与桌面壳均为 Windows 优先 |
| A1111 / Forge / ReForge WebUI | 可选* | 由 Stability Matrix 启动，启动参数带 `--api --port 7860` — SD/WAI 出图需要 |
| ComfyUI | 可选* | 位于 `http://127.0.0.1:8188` — Anima / Krea 2 / Wan / H3 引擎路径需要 |
| cloudflared | 可选 | 仅用于生成临时公网分享链接 |
| GPT-SoVITS | 可选 | 仅用于 AI 声线（角色专属权重） |
| Ollama | 可选 | 仅用于角色空间的角色对话 |

\* 至少有一个出图引擎在线才能生成；浏览场景、Prompt 与参考档案库不需要任何引擎。

### 第 1 步 — 获取代码

```bash
git clone https://github.com/starplatium1129-stack/huiyu.git
cd huiyu
```

### 第 2 步 — 安装依赖

```bash
npm install
```

`control.bat` 首次启动时也会自动执行 `npm install`。

### 第 3 步 — 编译运行时服务

全新克隆后必须先把 TypeScript 运行时编译一次——生成的 `.js` 不入库（已被 Git 忽略）：

```bash
npm run build:runtime
```

通过 `npm start` 或启动器（`control.bat` / `start.ps1`）启动时会经 `prestart` 钩子自动补齐这一步，可以跳过。

### 第 4 步 — 启动

**A. 控制面板（推荐）。** 先在 Stability Matrix 中启动 WebUI（记下日志中的地址，通常是 `http://127.0.0.1:7860`），然后双击 `control.bat`，确认 WebUI 地址后点击 **启动并生成分享链接**，再点 **打开本地网站（无需 Token）** 本地使用；需要分享时复制带 Token 的链接给朋友。使用结束点击 **停止全部服务**。

**B. 手动启动（排错 / 看完整日志）。**

```powershell
npm install
npm run build:runtime
$env:SD_HOST = 'http://127.0.0.1:7860'   # WebUI 地址
node server.js
```

只想测试本地网关时先设置 `$env:DISABLE_TUNNEL = '1'` 跳过公网隧道。`Ctrl+C` 停止。

**C. 开发模式（HMR）。** 开两个终端：

```powershell
npm run dev:server   # Express 网关 :3000（API、SD 代理、静态服务）
npm run dev          # Vite 开发服务器 :5173（热更新）
```

完整说明、可选组件（语音、聊天、双人构图）与排错方法见 [STARTUP.md](STARTUP.md)。

## 使用示例

### A. 从场景到一张成图

1. 打开**场景库**，按角色 / 内容分级筛选，点开一个 Scene——故事、情绪、镜头、光照与 Prompt 已全部就位。
2. 进入**导演台**，从 39 位精选画风中挑选一个，点击生成。
3. 提示词编译器会自动适配当前引擎：SD/WAI（Danbooru 标签）、Anima 1.1（`@artist` + 原生标签流）或 Krea 2 Turbo（3~5 句纯英文散文）。

### B. AI 叙事短片（纯点击流）

1. 打开场景蓝图 → **一键剧本**（自动四镜分镜：起承转合，台词取场景原文）→ **一键首帧**（逐镜 Krea 2 增强链路出首帧）→ 批量生成 + 尾帧衔接拼接。
2. 支持 Wan 2.2 TI2V 与 MiniMax H3 Ref2VA 锁脸；对白语言显式控制（`dialogueLang: auto/zh/ja/en`）。

### C. 角色房间、语音与桌面伴侣

- **更多 → 角色对话** 连接本机 Ollama；开启**回复后自动配音**后，中文回复会先经本地翻译链路，再由 GPT-SoVITS 生成日语声线，Live2D 立绘随音频振幅对口型。
- Tauri 2 桌面伴侣（`npm run dev:tauri` 开发、`npm run package:tauri` 打包 NSIS 安装版）提供无边框置顶的角色悬浮窗、托盘菜单与全局快捷键。

### D. 常用命令行操作

```powershell
npm run workflow -- --help          # 140+ 维护脚本的统一入口
npm run workflow -- data:validate   # 编辑场景数据后校验分片与 DATA_VERSION
npm run workflow -- gate:quick ui   # 按改动面积分层跑门禁（ui/server/data/all）
npm run scenes:import               # 从分片重建 data/scenes.json（批次感知）
npm run popular:build               # 重建 data/popular-characters.json
npm run build                       # 生产构建 + 140KB 路由预算 + 预压缩
```

完整脚本索引见 [docs/workflow.md](docs/workflow.md)。

## 贡献指南

这个项目首先是个人项目，但欢迎范围明确的贡献。动手前请按顺序先读：[docs/INDEX.md](docs/INDEX.md)（文档全景索引）→ [docs/workflow.md](docs/workflow.md)（统一脚本入口）→ **AGENTS.md**（协作宪章，本仓库最高权威）。

### 开发环境

见「安装」第 4 步 C（两个终端：Express 网关 + Vite HMR）。编辑过程中 `npm run typecheck` 与 `npm run lint:js` 可快速反馈。

### 质量门禁——提交前必须全部通过

```
[1. 状态与逻辑自测] ─► [2. 静态类型检查] ─► [3. 契约测试] ─► [4. 打包预算] ─► [5. 精准提交]
```

```powershell
npm run typecheck:app           # Vue SFC 类型检查，零 Error 退出
npm run workflow -- check:full  # 完整校验（13 项并行检查 + 单测 + 契约）
npm run build                   # 生产构建，18 个路由严守 140KB 预算
```

快速迭代只跑改动面积：`npm run workflow -- gate:quick ui|server|data|all`。

### 提交纪律（硬性红线）

- **严禁盲目 `git add .`**——只暂存你核对过的受控文件（先看 `git status` 与 `git diff`），不要卷入他人正在进行的脚本或分支。
- **严禁 `git reset --hard`** 等破坏性命令；临时测试脚本随用随清。
- 一个提交只做一件事；先过门禁再提交，而不是提交后再补。

### 不可妥协的工程红线

- **动效只用 GPU 合成属性**。过渡动画必须用 `transform`/`opacity`；用 `left/top/width/height` 补间会触发逐帧重排，门禁（`npm run lint:animations`）直接失败，除非带 `/* compositor-exempt: <理由> */` 注释。
- **图标一律手绘线条 SVG**。新增图标必须使用 Hand-drawn Linear 机制（`ArchiveIcon.vue`），严禁 Emoji 或实心填充图标。
- **内容分级 Fail-Closed**。R18 内容默认模糊遮罩；`adultEligibility` + `adultEnabled` 双重把关，未知或未授权状态必须严格拒绝，不得回退"安全"断言。
- **定稿场景是字节级基线**。`data/prompt-pinned-scenes.json` 中 100 条定稿场景的渲染字段严禁被批量工具触碰（`npm run scenes:pin` 强制校验）；确需修改时先真实出图自测。
- **严禁偷懒式批量交付**。批量重写必须逐条全量真实改写，通过 `test-prompt-rewrite-integrity.js`（覆盖率=声明数、无模板签名、保留率≤50%、prose 相似度≤60%）。
- **只维护深色主题**。浅色主题已下线，新增颜色只写一遍；禁用态用 `--text-disabled` 令牌，不得用 `opacity` 压字。
- **样式契约以 DESIGN.md 为准**。运行时 CSS 是派生实现，冲突时以契约为准。

### 测试

```powershell
npm run test:frontend   # vitest 单元测试
npm run test:unit       # quality-suite 单测分组
npm run test:contract   # 内容与接口契约测试
npm run test:e2e        # Playwright 端到端（会先构建）
```

### 文档

新文档与重大更新必须在 [docs/INDEX.md](docs/INDEX.md) 登记。文档必须与代码实际行为保持一致——过期注释与契约视为缺陷。

## 项目结构

```text
huiyu/
├── DESIGN.md               # 网站与控制面板的唯一总设计规范
├── AGENTS.md               # 项目约束、质量门槛与协作者开发指南
├── index.html              # Vite SPA 入口（无全局脚本注入）
├── vite.config.ts          # Vite 构建配置 + dev 代理
├── control.bat             # Windows 控制面板入口
├── server.js               # Express：静态服务、SD 代理、临时分享
├── src/                    # Vue 3 SPA 源码（Vite 构建目标）
│   ├── config/             #   角色常量、画师库、导演台静态定义
│   ├── utils/              #   流式解析、角色参考库数据、Prompt 编译器
│   ├── stores/             #   Pinia：场景数据、导演台状态
│   ├── composables/        #   Voice / Live2D / Chat / SD / IndexedDB
│   ├── components/         #   布局、导航、主题切换、视频工作台组件
│   ├── views/              #   每路由一个 Vue 视图组件（全部懒加载）
│   └── assets/css/         #   设计系统 Token、组件样式
├── routes/                 # Express API 路由（chat / voice / live2d / video / maintenance）
├── services/               # TypeScript 运行时服务（Ollama、TTS、HTTP…）
├── desktop-tauri/          # Tauri 2 壳、Native Live2D overlay、sidecar 与打包
├── types/                  # 共享 TypeScript 类型定义
├── data/                   # 运行时 JSON 数据（scenes / characters / blueprints / standards）
├── assets/                 # 静态资源（角色立绘、Live2D、vendor SDK）
├── docs/                   # 创作规范、质量标准、全景索引（docs/INDEX.md）
├── scripts/                # 维护、测试、参考图生成与运行辅助脚本
└── runtime/                # 本机配置、日志、进程状态与朋友生成图（Git 忽略）
```

## 维护与校验

```powershell
npm run typecheck:app     # Vue SFC 与前端 TypeScript 类型检查
npm run build             # 构建生产前端产物
npm run validate          # 完整校验：代码规范 + 构建 + 类型检查 + 契约测试
```

日常增删场景、修改故事、维护标签或替换样张，直接使用网站中的 **更多 → 场景管理**。

当前实现、验证基线、阻断项和完整文档索引见 [docs/project-status.md](docs/project-status.md) 与 [docs/INDEX.md](docs/INDEX.md)。

## 维护原则

1. 自己和朋友实际会用的功能优先。
2. 本地数据和简单启动优先。
3. 场景质量与参考图保真度优先于单纯数量。
4. 分享功能默认保持临时、可停止、需要 Token。
5. 不为了版本号扩张成公开平台。
6. 桌面端是主要使用环境；移动端保持基本可用。

> Prompt 描述图片，Scene 描述瞬间。这个工具要做的，是让那个瞬间更容易被画出来。

## License

MIT 协议，见 [LICENSE](LICENSE)。角色内容及其原作版权归原权利方所有，本项目为同人性质的非官方作品，不主张对其的所有权。
