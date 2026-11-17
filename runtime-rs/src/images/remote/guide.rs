use axum::{
    Json,
    http::header,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::sync::LazyLock;

pub(super) const PATH: &str = "/api/muse/guide";
pub(super) const LINK: &str = "</api/muse/guide>; rel=\"help\"; type=\"application/json\"";

/// Marks status handlers reached through the remote drawing listener.
#[derive(Clone)]
pub(in crate::images) struct Guide;

static DOCUMENT: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "name": "绘遇远程出图",
        "protocol": "huiyu-muse",
        "version": 2,
        "guidePath": PATH,
        "authHeader": "X-Token",
        "usage": "使用当前连接的地址和已保存的 X-Token。以下路径均相对于当前地址。",
        "sceneModels": ["anima-miaomiao-v1.6", "moss-miaomiao-base-v1.0", "moss-miaomiao-base-v1.1"],
        "operations": {
            "catalog": {
                "method": "GET", "path": "/api/muse/catalog",
                "query": "kind=character 查角色，kind=outfit 查服装，kind=media 查场景和蓝图。可传 search、character 和 rating（如 R18）。pageSize 最大 500，按 nextPage 翻页，ratings 列出分级。",
                "example": "/api/muse/catalog?kind=outfit&character=nene"
            },
            "details": {
                "method": "GET", "path": "/api/muse/catalog/{kind}/{id}",
                "usage": "scene 或 blueprint 查看种子和变体。outfit 查看标签词和兼容模型，使用完整服装 ID，保留其中的斜杠。"
            },
            "draw": {
                "method": "POST", "path": "/api/muse/jobs",
                "json": {"id": "sc093", "requestKey": "new UUID", "variants": 3},
                "usage": "传场景 id，可加同一角色的 outfitId 换装。只传 outfitId 可独立出服装图。可选 seed、modelId，每项最多 8 张。"
            },
            "prompt": {
                "method": "POST", "path": "/api/muse/jobs",
                "json": {"prompt":"your image prompt","requestKey":"new UUID"},
                "usage": "直接提交自定义提示词，不与目录 ID 混用。可选 modelId、宽高 width/height、seed、variants。Anima 可传 character 自动匹配本机已安装的 LoRA。"
            },
            "batch": {
                "method": "POST", "path": "/api/muse/batches",
                "json": {"ids": ["sc041", "sc093"], "requestKey": "new UUID", "variants": 3},
                "usage": "可用 items 逐项指定场景、服装或 prompt。每批最多 16 张，响应含批次和每项的 statusPath。"
            },
            "queue": {"method": "GET", "path": "/api/muse/queue", "usage": "查看排位、进度和可用的时间估算。"},
            "recent": {"method": "GET", "path": "/api/muse/jobs", "usage": "断线后先查 items；entryType=batch 表示批次，image 表示单张。按 statusPath 恢复，since 接受 RFC3339 或 Unix 毫秒。"}
        },
        "retry": "同一次提交重试时复用原请求体和 requestKey。",
        "followup": "GET 返回的 statusPath 查状态，批次单项返回 item。按用户要求取消时，向 cancelPath 发 DELETE。",
        "download": "从成功的 job、item 或批次 items 取 resultUrl。断线后保留部分文件，以 Range: bytes=N- 和原 ETag 作为 If-Range 续传。仅在 206 且 Content-Range 从 N 开始时追加，200 时替换。完成后核对可用的 resultBytes 和 resultSha256 再展示。"
    })
});

impl Guide {
    pub(in crate::images) fn document() -> &'static Value {
        &DOCUMENT
    }
}

pub(super) async fn read() -> Response {
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        Json(Guide::document()),
    )
        .into_response()
}
