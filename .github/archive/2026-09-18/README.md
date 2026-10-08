# 2026-09-18 专项工作流归档

这八个工作流只面向 `codex/tag-inspiration-repair-20260918` 或 `codex/storage-safety-20260918`，绑定固定历史提交/补丁，不验证当前主线。2026-10-08 可维护性整理将文件原样移出 `.github/workflows/`，保留复现来源与 Git 历史；GitHub 不会自动发现此目录中的工作流。

现行检查继续使用 [Quality](../../workflows/quality.yml)、[Rust Runtime](../../workflows/rust-runtime.yml)和显式运行的 [Windows Native](../../workflows/windows-native.yml)。未来若恢复某个历史专项，先重新核对分支、提交、补丁、权限和目标，不能直接把旧结果当作当前验收。
