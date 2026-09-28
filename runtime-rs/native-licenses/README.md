# Windows x64 原生依赖材料

状态：**可用于制作本地候选包；尚未完成公开发行许可核验。** 本目录不包含 DLL、模型或安装程序，也不安装任何库。所有原文保持取得时的字节，逐文件摘要见 `materials.sha256.json`。

## 已锁定的二进制来源

- `libvips-42.dll`：`@img/sharp-win32-x64@0.35.4` 的 DLL 与官方 [build-win64-mxe v8.18.6](https://github.com/libvips/build-win64-mxe/releases/tag/v8.18.6) 的 `vips-dev-x64-web-8.18.6-static.zip` 中 `vips-dev-8.18/bin/libvips-42.dll` 完全一致：18,614,784 字节，SHA-256 `e6cc51bbc763e7deda536c6f56ce96b4c51ea769690ce4f4ed07607527b81dae`。ZIP 摘要为 `42ceea0c2f53d1244f3cb54c059881487b37452ee46c1c98c0d4b47480b20588`，与官方发布页公布的摘要一致。核验在内存中完成，只保存了 ZIP 的许可证、README 和版本表。
- `onnxruntime.dll`：保留既有 `onnxruntime-node@1.30.0` 锁定 DLL、MIT 许可证和该版本完整 `ThirdPartyNotices.txt`。npm 包下载地址和完整性字段记录于上层 manifest；DLL 自身的 SHA-256 才是候选包验收值。不要用另一个 CPU/DirectML ZIP 的同名 DLL 直接替换。
- sharp 的 Windows 预构建脚本按 libvips 版本下载上述 MXE 发布包。`sharp-libvips` 使用 `v1.3.x` 标签，**不存在相同含义的 `sharp-libvips v8.18.6` 标签要求**。已保存 `v1.3.3` 的 Windows 脚本和版本表作构建路径证据；其中其他平台 AOM 版本不同，不能据它覆盖 Windows ZIP 的版本表。

## 组件与源码证据

`components.json` 记录每个组件的准确版本、构建配方、源码 URL、预期及实测 SHA-256、所取许可/版权文件和各自摘要。

- 版本表中的 **28 项**源码包均与构建配方 SHA-256 相符；`components/` 已保存匹配源码包内的许可、版权、专利声明以及需要继续核对的 Cargo/Wrap 清单。
- 第 29 项 `libnsgif` 是 libvips 8.18.6 自带的 `libvips/foreign/libnsgif/` 源码。其 MIT `COPYING` 在匹配的 libvips 源码包内；上游 README 仅写最后更新日期 2023-01-22，没有单独发布版本或固定上游 commit，故这里只以 libvips 源码版本标识它。
- 另外收集了 GLib 的 PCRE2 10.46（与 Wrap 源码 SHA-256 匹配）和强制回退 GVDB（Wrap 固定 Git commit `2b42fc75f09dbe1cd1057580b5782b08f2dcb400`）。GVDB 原 Wrap 未给 archive checksum，本次实测摘要不能冒充发布者提供的摘要。
- `build-win64-mxe-v8.18.6/` 是官方构建仓库标签 `09cfccf20b91b441fbe97fa7a7ed8a597e55e830` 的完整小型配方/补丁快照；其来源 ZIP 与逐文件摘要另有 evidence JSON。`mxe-d973945/` 保存基础配方与 MIT 许可，说明哪些版本被发布标签的 override 替换。
- `libimagequant` 使用 Lovell 的 BSD 2-Clause **2.4.1 分支**；没有用当前上游不同许可的版本替代。mozjpeg 使用发布配方锁定的 `08265790774cd0714832c9e675522acbe5581437`。
- 源码发行包里的测试/工具版权文件一并留存用于审查，**不能据此断言这些可选源码都链接进 DLL**。例如 Cairo 的工具目录包含 GPL 文本，而其根 COPYING 明确区分了库实现和辅助程序。

## 仍未闭合的公开发行事项

1. **链接后依赖清单与完整通知。** librsvg 的匹配 `Cargo.lock` 有 350 个 crates.io 包，含构建、开发和可选依赖。`librsvg-2.62.91-cargo-sources.json` 已给出每项固定版本、下载 URL 和锁定 SHA-256；尚未取得实际 Windows feature/target 的链接清单及其完整通知，不能把 Cargo.lock 全部包当成最终 DLL 的依赖，也不能忽略其中实际静态链接的 Rust crate。LLVM/MinGW 静态运行时的版权闭包也需要确认。
2. **完整对应源码与构建环境。** 发布标签默认采用可变的 `ghcr.io/libvips/build-win64-mxe:latest`，基础仓库克隆可变分支 `llvm-mingw-20260605`。本次取得的 MXE 分支 tip 是 `d973945bb92c7783d5afa41bb2b8d2e1a04eaba3`，没有证据证明它就是官方 DLL 构建时的基座 commit。还需固定实际 OCI digest/工具链、动态获取的 Wrap 补丁和 Rust 依赖，并验证对应源码的构建可用性；下载到源码不等于已经能重现整个 DLL。
3. **发行时选定并落实许可路径。** sharp 声明 LGPL 部件通过旧 LGPL 的 later-version 条款按 LGPLv3 使用；这里同时保留原文、LGPLv3 和 GPLv3。Cairo 根源码仍附 MPL 1.1/LGPL 2.1 双许可文本，sharp 表中写的是 MPL 2.0，也保留 MPL 2.0 原文供核对。最终通知、源码交付方式以及 LGPL 组合库的修改/重新组合要求仍须明确，不能把 Apache 的 sharp 包许可证当作整个 DLL 的许可证。
4. **候选包的替换与运行验证。** 应保留原生 DLL 为独立可替换文件，验证安装位置/访问权限不会阻止替换兼容 DLL，并核对产品条款不限制相关许可允许的调试修改。现有隔离测试不替代最终安装包的 DLL 搜索、系统运行库和真实 WD14 权重验收。

这些是可定位的发行待办，不是“已合规”声明。本目录没有作出公开发布动作。

## 本地候选包采集步骤

1. 从上层 `native-dependencies.windows-x64.json` 指定的本地已验证文件，或 libvips 的精确官方 ZIP，取得**仅两个锁定 DLL**。先核对字节数/SHA-256，再放入候选应用的 `native/`；无需复制 `sharp.node`、`onnxruntime_binding.node` 或执行 Node 来加载它们。
2. 将本目录的通知与索引按原样随候选包留档。只把许可文件称为通知，不将构建脚本、Cargo 清单称为许可证。`materials.sha256.json` 可以逐项验证留档副本。
3. 若需重新采集源码许可，在 PowerShell 7 中执行 `./collect-sources.ps1`。它只下载 `components.json` 列明的公共源码，核对配方摘要，再用系统 `tar.exe` 以 stdout 读取选定文档，不运行源码。采集脚本是可编辑的开发工具，不属于上游原文，不进入材料清单或通知包；它继续采用仓库正常的 PowerShell 编码/换行检查。缓存位于被 Git 忽略的 `.downloads/`；可以按 `observedArchive` 核验后用于准备后续对应源码包。`-Only aom,vips` 可限定组件。采集结束后若增减材料，需要重新生成索引，不能沿用旧摘要索引。
4. VC++ 系统运行库需求以主 manifest 中原 PE 导入清单为准。不要把 Windows 的 `api-ms-win-*` 合约名当作待复制的私有 DLL。ORT 的 `MSVCP140.dll`、`MSVCP140_1.dll`、`MSVCP140_ATOMIC_WAIT.dll`、`VCRUNTIME140.dll`、`VCRUNTIME140_1.dll` 保持系统/官方 VC++ Redistributable 前置项；本次没有安装或重分发它们。
5. 当前只使用 ORT CPU provider。`DirectML.dll`、`d3d12.dll`、`dxgi.dll` 是已记录的延迟导入；不要为未启用的 provider 把 DirectML、dxcompiler、dxil 等额外 DLL 加进候选包。

本地候选验证状态和公开发行许可状态必须分别记录。

## 原文保留与仓库检查

`scripts/lib/native-license-materials.ts` 是本材料包的专用验证入口。根 `native-dependencies.windows-x64.json` 的 `licenseEvidence.indexBytes` 与 `indexSha256` 绑定整个 `materials.sha256.json`；后者逐文件绑定大小和 SHA-256。校验拒绝绝对路径、目录穿越、Windows ADS/保留名、重复路径和进入 `.downloads/` 缓存的条目。

卫生门禁分别使用 Git index、worktree、untracked 对应的原始字节和清单；不能用工作树副本覆盖暂存区的判断。只有已列入清单、字节匹配且位于指定上游材料范围的文件，才保留原有 CRLF、空白、版权文本及来源 JSON。清单自身也必须先通过根 manifest 的摘要绑定。未绑定的新文件、这里的自写 README、`.gitignore` 和普通源码继续按常规规则检查。

桌面候选包按完整清单复制并再次校验材料，包含本 README 与清单自身，不再只复制 `licenses` 中的少数顶层通知。编辑 README 或增减清单条目后，需要同时更新材料索引及根 manifest 的索引摘要；不得为了通过格式检查改写上游原文。
