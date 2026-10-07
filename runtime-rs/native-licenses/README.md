# Windows x64 原生依赖材料

状态：**可用于制作本地候选包；尚未完成公开发行许可核验。** 本目录不包含 DLL、模型或安装程序，也不安装任何库。所有原文保持取得时的字节，逐文件摘要见 `materials.sha256.json`。

## 已锁定的二进制来源

- `libvips-42.dll`：`@img/sharp-win32-x64@0.35.4` 的 DLL 与官方 [build-win64-mxe v8.18.6](https://github.com/libvips/build-win64-mxe/releases/tag/v8.18.6) 的 `vips-dev-x64-web-8.18.6-static.zip` 中 `vips-dev-8.18/bin/libvips-42.dll` 完全一致：18,614,784 字节，SHA-256 `e6cc51bbc763e7deda536c6f56ce96b4c51ea769690ce4f4ed07607527b81dae`。ZIP 摘要为 `42ceea0c2f53d1244f3cb54c059881487b37452ee46c1c98c0d4b47480b20588`，与官方发布页公布的摘要一致。核验在内存中完成，只保存了 ZIP 的许可证、README 和版本表。
- sharp 的 Windows 预构建脚本按 libvips 版本下载上述 MXE 发布包。`sharp-libvips` 使用 `v1.3.x` 标签，**不存在相同含义的 `sharp-libvips v8.18.6` 标签要求**。已保存 `v1.3.3` 的 Windows 脚本和版本表作构建路径证据；其中其他平台 AOM 版本不同，不能据它覆盖 Windows ZIP 的版本表。

## 当前消费与打包边界

2026-10-07：Rust 反推入口 [interrogate.rs](../src/interrogate.rs) 只接入 PixAI，[worker 启动](../src/interrogate/pixai.rs) 使用 Python 子进程。随 ORT 的 Cargo/npm 依赖退役，[桌面暂存工具](../../scripts/maintenance/desktop-rust-inputs.ts) 和新包材料清单仅保留 `libvips-42.dll`；开发启动、资源同步身份检查和原生验收也不再要求 ORT。

本目录已移除仅随 ORT 分发的两份通知及索引引用，旧版本来源与材料可从 Git 历史追溯。这是新包输入范围的变更，不会清理已安装目录的旧 DLL，也不代表已完成重新打包、安装或设备验收。libvips 的来源、通知和摘要绑定继续保留；历史 CPU WD14 验收不作为当前 PixAI 功能的完成条件，PixAI 的真实模型与设备验收单独记录。

## 组件与源码证据

`components.json` 记录每个组件的准确版本、构建配方、源码 URL、预期及实测 SHA-256、所取许可/版权文件和各自摘要。

- 版本表中的 **28 项**源码包均与构建配方 SHA-256 相符；`components/` 已保存匹配源码包内的许可、版权、专利声明以及需要继续核对的 Cargo/Wrap 清单。
- 第 29 项 `libnsgif` 是 libvips 8.18.6 自带的 `libvips/foreign/libnsgif/` 源码。其 MIT `COPYING` 在匹配的 libvips 源码包内；上游 README 仅写最后更新日期 2023-01-22，没有单独发布版本或固定上游 commit，故这里只以 libvips 源码版本标识它。
- 另外收集了 GLib 的 PCRE2 10.46（与 Wrap 源码 SHA-256 匹配）和强制回退 GVDB（Wrap 固定 Git commit `2b42fc75f09dbe1cd1057580b5782b08f2dcb400`）。GVDB 原 Wrap 未给 archive checksum，本次实测摘要不能冒充发布者提供的摘要。
- `build-win64-mxe-v8.18.6/` 是官方构建仓库标签 `09cfccf20b91b441fbe97fa7a7ed8a597e55e830` 的完整小型配方/补丁快照；其来源 ZIP 与逐文件摘要另有 evidence JSON。`mxe-d973945/` 保存基础配方与 MIT 许可，说明哪些版本被发布标签的 override 替换。
- `libimagequant` 使用 Lovell 的 BSD 2-Clause **2.4.1 分支**；没有用当前上游不同许可的版本替代。mozjpeg 使用发布配方锁定的 `08265790774cd0714832c9e675522acbe5581437`。
- 源码发行包里的测试/工具版权文件一并留存用于审查，**不能据此断言这些可选源码都链接进 DLL**。例如 Cairo 的工具目录包含 GPL 文本，而其根 COPYING 明确区分了库实现和辅助程序。

### librsvg 构建配方已知范围

`librsvg-2.62.91-cargo-sources.json` 保持原始源码 `Cargo.lock` 的 350 项定位清单。官方固定提交中的 [librsvg 补丁](https://github.com/libvips/build-win64-mxe/blob/09cfccf20b91b441fbe97fa7a7ed8a597e55e830/build/patches/librsvg-2-fixes.patch) 与本地留档一致地记录了以下变化：

- 从锁文件移除 `color_quant 1.1.0`、`gif 0.14.2`、`image-webp 0.2.4`、`weezl 0.1.12`；`weezl 0.2.1` 仍保留。仅扣除这四项后是 346 个注册表包候选，**仍不是实际链接包数**，不据此改写原始锁文件或通知完成状态。
- 关闭 cairo-rs 的 PDF/PostScript feature，关闭 SVG 内嵌图片的 GIF/WebP feature；此范围不等同 libvips 整体不支持 GIF/WebP。
- [构建 override](https://github.com/libvips/build-win64-mxe/blob/09cfccf20b91b441fbe97fa7a7ed8a597e55e830/build/overrides.mk) 关闭 introspection、pixbuf、pixbuf-loader、rsvg-convert、docs、vala 和 tests，设置 Rust triplet 为 `$(PROCESSOR)-pc-windows-gnullvm`；x64 配方对应 `x86_64-pc-windows-gnullvm`。这些是配方输入，尚无本次官方 DLL 的完整链接输出与 feature 解析记录。

下一步所需证据是该 DLL 构建时的命令/日志、应用补丁后的 feature/target 依赖图、链接产物与静态工具链通知；无需为补齐上述已知配方范围下载全部 350 个源码包。当前 OCI `latest`、当前分支 tip 或重新构建的 digest 都不能替代原发行构建的身份。

### 发行资产与构建关联（2026-10-07 只读核对）

- [官方资产 API](https://api.github.com/repos/libvips/build-win64-mxe/releases/assets/529570208) 将 `vips-dev-x64-web-8.18.6-static.zip` 定位为资产 `529570208`：9,322,134 字节，摘要 `sha256:42ceea0c2f53d1244f3cb54c059881487b37452ee46c1c98c0d4b47480b20588`，与既有 ZIP 留档一致。资产创建时间为 `2026-08-25T17:53:54Z`；本次未重新下载或运行二进制。
- [标签引用 API](https://api.github.com/repos/libvips/build-win64-mxe/git/ref/tags/v8.18.6) 当前返回 commit `09cfccf20b91b441fbe97fa7a7ed8a597e55e830`。该固定提交中的 [OCI 工作流](https://github.com/libvips/build-win64-mxe/blob/09cfccf20b91b441fbe97fa7a7ed8a597e55e830/.github/workflows/oci-publish.yml) 只由 `workflow_dispatch` 触发，构建并推送 `container/base.Dockerfile` 的基础镜像；没有 DLL/ZIP 构建或 Release 上传步骤，不能将它的 run 当作此 ZIP 的发行构建。
- 同一提交的 [build.sh](https://github.com/libvips/build-win64-mxe/blob/09cfccf20b91b441fbe97fa7a7ed8a597e55e830/build.sh) 默认以 `latest` 拉取基础镜像，再构建 Windows 包；快照中的打包脚本生成 ZIP，但未保存该发行的上传关联。按上述 head SHA 查询 Actions，本次返回 0 条；以该 ZIP 摘要查询仓库 attestation 端点返回 HTTP 404。这些可见接口结果不证明不存在其他来源证明，也不能反推出当时解析的 OCI digest。

这条构建来源链仍缺少同时绑定此 ZIP/DLL 摘要、实际构建记录和所用 OCI digest 的原始回执或日志。单独找到 OCI 发布 run、短 SHA 标签或当前 `latest` 都不足以补上这一关联。原始资产/标签响应与查询观察保存在忽略的 `runtime/native-provenance-20261007/`；本次没有取得实际构建来源证明，后面的待项和审批状态不变。

## 仍未闭合的公开发行事项

1. **链接后依赖清单与完整通知。** librsvg 的原始 `Cargo.lock` 有 350 个 crates.io 包，含构建、开发和可选依赖，须结合上节构建补丁继续缩定范围。`librsvg-2.62.91-cargo-sources.json` 已给出每项固定版本、下载 URL 和锁定 SHA-256；尚未取得实际 Windows feature/target 的链接清单及其完整通知，不能把 Cargo.lock 全部包当成最终 DLL 的依赖，也不能忽略其中实际静态链接的 Rust crate。LLVM/MinGW 静态运行时的版权闭包也需要确认。
2. **完整对应源码与构建环境。** 发布标签默认采用可变的 `ghcr.io/libvips/build-win64-mxe:latest`，基础仓库克隆可变分支 `llvm-mingw-20260605`。本次取得的 MXE 分支 tip 是 `d973945bb92c7783d5afa41bb2b8d2e1a04eaba3`，没有证据证明它就是官方 DLL 构建时的基座 commit。还需固定实际 OCI digest/工具链、动态获取的 Wrap 补丁和 Rust 依赖，并验证对应源码的构建可用性；下载到源码不等于已经能重现整个 DLL。
3. **发行时选定并落实许可路径。** sharp 声明 LGPL 部件通过旧 LGPL 的 later-version 条款按 LGPLv3 使用；这里同时保留原文、LGPLv3 和 GPLv3。Cairo 根源码仍附 MPL 1.1/LGPL 2.1 双许可文本，sharp 表中写的是 MPL 2.0，也保留 MPL 2.0 原文供核对。最终通知、源码交付方式以及 LGPL 组合库的修改/重新组合要求仍须明确，不能把 Apache 的 sharp 包许可证当作整个 DLL 的许可证。
4. **候选包的替换与运行验证。** 应保留 libvips DLL 为独立可替换文件，验证安装位置/访问权限不会阻止替换兼容 DLL，并核对产品条款不限制相关许可允许的调试修改。现有隔离测试不替代最终安装包的 DLL 搜索和适用 Windows 系统运行库验收。

这些是可定位的发行待办，不是“已合规”声明。本目录没有作出公开发布动作。

## 本地候选包采集步骤

1. 从上层 `native-dependencies.windows-x64.json` 指定的本地已验证文件，或 libvips 的精确官方 ZIP，取得**唯一锁定 DLL `libvips-42.dll`**。先核对字节数/SHA-256，再放入候选应用的 `native/`；无需复制 `sharp.node` 或执行 Node 来加载它。
2. 将本目录的通知与索引按原样随候选包留档。只把许可文件称为通知，不将构建脚本、Cargo 清单称为许可证。`materials.sha256.json` 可以逐项验证留档副本。
3. 若需重新采集源码许可，在 PowerShell 7 中执行 `./collect-sources.ps1`。它只下载 `components.json` 列明的公共源码，核对配方摘要，再用系统 `tar.exe` 以 stdout 读取选定文档，不运行源码。采集脚本是可编辑的开发工具，不属于上游原文，不进入材料清单或通知包；它继续采用仓库正常的 PowerShell 编码/换行检查。缓存位于被 Git 忽略的 `.downloads/`；可以按 `observedArchive` 核验后用于准备后续对应源码包。`-Only aom,vips` 可限定组件。采集结束后若增减材料，需要重新生成索引，不能沿用旧摘要索引。
4. Windows 系统运行库需求以主 manifest 中 libvips 的 PE 导入清单为准。不要把 `api-ms-win-*` 合约名当作待复制的私有 DLL。ORT 专属的 VC++ / provider 导入清单已退出当前包；不要据旧材料添加 DirectML、dxcompiler、dxil 或系统 DLL。本次没有安装或重分发系统运行库。

本地候选验证状态和公开发行许可状态必须分别记录。

## 原文保留与仓库检查

`scripts/lib/native-license-materials.ts` 是本材料包的专用验证入口。根 `native-dependencies.windows-x64.json` 的 `licenseEvidence.indexBytes` 与 `indexSha256` 绑定整个 `materials.sha256.json`；后者逐文件绑定大小和 SHA-256。校验拒绝绝对路径、目录穿越、Windows ADS/保留名、重复路径和进入 `.downloads/` 缓存的条目。

卫生门禁分别使用 Git index、worktree、untracked 对应的原始字节和清单；不能用工作树副本覆盖暂存区的判断。只有已列入清单、字节匹配且位于指定上游材料范围的文件，才保留原有 CRLF、空白、版权文本及来源 JSON。清单自身也必须先通过根 manifest 的摘要绑定。未绑定的新文件、这里的自写 README、`.gitignore` 和普通源码继续按常规规则检查。

桌面候选包按完整清单复制并再次校验材料，包含本 README 与清单自身，不再只复制 `licenses` 中的少数顶层通知。编辑 README 或增减清单条目后，需要同时更新材料索引及根 manifest 的索引摘要；不得为了通过格式检查改写上游原文。
