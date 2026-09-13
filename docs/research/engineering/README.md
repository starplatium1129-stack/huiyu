# 工程研究与复核资料

2026-09-13。以下报告按已核验范围归档，不能把报告交付、文件存在或源码检查当成图片/设备验收。

| 资料 | 本轮可采纳的内容 | 仍待验证 |
| --- | --- | --- |
| [资产账本](gemini-asset-audit.md) / [JSON](gemini-asset-audit.json) | 334 个物理文件的尺寸、格式、字节数、SHA-256 与 160 个角色的用途映射；共 273,392,941 B | 图片质量、外部参考图和容量、安装包体积及运行表现 |
| [图片候选](gemini-visual-inventory.md) / [JSON](gemini-visual-inventory.json) | 45 条候选的源文件元数据；43 条对应既有 All 登记，2 个先导样例未新增评级 | 完整图片独立复核；其余 115 位待确认 |
| [图片使用位置](gemini-crop-usage.md) / [JSON](gemini-crop-usage.json) | 5 类容器的实际资源、样式、错误回退代码 | 具体图片裁切、双主题与真实窗口视觉表现 |
| [文案复核](gemini-ui-copy-review.md) / [JSON](gemini-ui-copy-review.json) | 6 项：1 项确认只读提示不匹配、4 项可选建议、1 项误报撤回 | UI 修改与实际使用验证，当前未实施 |
| [文档证据索引](gemini-doc-evidence-index.md) / [JSON](gemini-doc-evidence-index.json) | 8 份文档的原文、入口和时效核对；撤回假引文 | 不能由历史说明推定当前设备测试通过 |
| [验收用例](gemini-resource-acceptance.md) / [JSON](gemini-resource-acceptance.json) | 6 项现状与 3 项未来 R1 用例设计，全部明确未执行 | 隔离环境执行及主力机验收 |

进度与缺口见 [任务状态](gemini-followup-progress.json)。首轮问题记录见 [资产交付复核](gemini-asset-review-2026-09-13.md)。GLM 工程实施见 [W1 复核](glm-w1-review-and-submit-scope.md)。

本次修订移除未经测量的图片百分比、像素距离、固定压缩收益与“实锤”裁切结论；纠正文档命令/路由、作品库已有入口、目录资源分流和错误徽章行为。没有修改业务代码、原图、生产数据或分级，没有运行模型、安装或发布。
