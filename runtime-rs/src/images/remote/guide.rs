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
        "version": 3,
        "guidePath": PATH,
        "authHeader": "X-Token",
        "usage": "使用当前地址、X-Token 与以下相对路径；新任务生成新 UUID requestKey，重试沿用原编号与原请求体。",
        "sceneModels": ["anima-miaomiao-v1.6", "moss-miaomiao-base-v1.0", "moss-miaomiao-base-v1.1"],
        "quickDraw": {
            "submit": "已有目录 id 或 prompt 时，直接 POST /api/muse/jobs，无需先查目录或队列。",
            "receive": "中转回执含 receivePath 时可直接 GET 长轮询（≤20s）；202 或 pending=true 按 Retry-After 续查，收到 PNG 后校验长度与 SHA-256。查进度或并行下载 GET statusPath。",
            "cli": "py tools/muse-relay/get_result.py <HTTPS根地址> @request.json 成图.png --submit（自动生成 requestKey 并等待校验保存；断线后凭 batchKey 续取）。"
        },
        "upscale": {
            "field": "upscale", "family": "anima", "scale": 1.5,
            "ultrasharp": {"mode": "放大并重绘", "sampler": "euler", "scheduler": "normal", "steps": 10, "cfg": 5.5, "denoise": 0.8, "shift": 3},
            "remacri": {"mode": "纯放大", "steps": 0},
            "off": "关闭放大，可覆盖批量默认。",
            "usage": "单张、自定义及批量均可用；items 优先于顶层默认值。width/height 传放大前尺寸。"
        },
        "moss": {
            "mossSampler": ["euler", "er-sde"],
            "mossAcceleration": ["off", "spectrum", "spectrum-adaptive"],
            "mossSpectrumFlexWindow": {"min": 0, "max": 2},
            "usage": "默认 Euler、50 步、CFG 3.5、Spectrum 0.5；er-sde 预览默认 25 步、CFG 2.5、完整计算。支持整批顶层设置与 items 单项覆盖（混合批次放对应项内）。",
            "canvas": "同时传 width/height 调整画幅，目录元素框按宽高比例缩放。"
        },
        "operations": {
            "desktopChat": {
                "inbox": "GET /api/muse/desktop/inbox", "reply": "POST /api/muse/desktop/reply",
                "usage": "桌面与 QQ 各保持独立 GET inbox?wait=25（HTTP 超时 ≥40s）；空收件箱立即续接，异常退避。按 conversationId 和 messages 回答，expiresAt 前凭原 requestKey 与 text 回传（一编号仅生成一次）。"
            },
            "qqChat": {
                "inbox": "GET /api/muse/qq/inbox", "reply": "POST /api/muse/qq/reply",
                "targets": "GET /api/muse/qq/targets", "send": "POST /api/muse/qq/send", "search": "POST /api/muse/qq/search",
                "json": {"requestKey":"收件编号","text":"回复文字"},
                "usage": "独立 GET inbox?wait=25（HTTP 超时 ≥40s），空结果立即续接。凭 recentMessages 回答，在 expiresAt 前凭原 requestKey 回传 text 和/或一个附件。",
                "context": "群聊 recentMessages 条数依绘遇设置，更多前文 GET /api/muse/qq/context/{conversationId}（近 1h ≤64 条）；私聊附最近 1h ≤6 条。",
                "groupRouting": "私聊与群 @ / /muse 转交 Muse；普通群消息需开启接收并获群主同意；绑定/帮助/取图仍由绘遇处理。",
                "senderIdentity": "群内按 senderId 认人，senderNickname 作称呼；senderRole=owner 为群主，admin 管理员，member 成员，unknown 未核实（私聊为 null）。",
                "image": {"mimeType":"image/jpeg|image/png","data":"标准 Base64，原文件 ≤3 MiB"},
                "audio": {"mimeType":"audio/mpeg","data":"MP3 标准 Base64，原文件 ≤3 MiB"},
                "delivery": "text 1–1600 字，可附 image 或 audio 二选一（也可仅附件）；status=sent 表 QQ 已确认，410 已失效。",
                "skip": "无需插话的普通群消息向 reply 或 /qq/replies 提交 {requestKey,skip:true}，返回 status=skipped。",
                "proactive": "开启 museProactive 后，先 GET targets 选 conversationId，再 POST send（新 requestKey + text/image/audio 三选一）。",
                "webSearch": "POST search 传原 requestKey + query（主动检索传新 UUID + conversationId + query），返回公开网页 title/url/snippet。",
                "vmMode": "QQ_MUSE_VM_POLL：走笔记本 Tailscale 反向轮询；QQ_MUSE_VM_ACTIVE：绘遇主动 POST /qq/questions 并 GET /qq/replies/{requestKey}。",
                "vmPoll": {"inbox":"GET /qq/pending","context":"GET /qq/context/{conversationId}","reply":"POST /qq/replies","targets":"GET /qq/targets","send":"POST /qq/send","search":"POST /qq/search"},
                "vmImageReply": "反向轮询支持 POST /qq/replies/{requestKey}/image 提交 JPEG/PNG 原始字节（匹配 Content-Type，≤3 MiB）。"
            },
            "catalog": {
                "method": "GET", "path": "/api/muse/catalog",
                "query": "kind=character|outfit|media(默认)；支持 search、character、rating（如 R18）、pageSize≤500、nextPage。",
                "example": "/api/muse/catalog?kind=outfit&character=nene",
                "outfitSelection": "服装按 displayTitle 区分角色同名配方，换装传完整 id。"
            },
            "details": {
                "method": "GET", "path": "/api/muse/catalog/{kind}/{id}",
                "usage": "查场景/蓝图种子与变体，或服装 tokens 与 compatibleModels（保留 id 内斜杠）。"
            },
            "draw": {
                "method": "POST", "path": "/api/muse/jobs",
                "json": {"id": "sc093", "requestKey": "replace-with-new-uuid", "upscale": "ultrasharp"},
                "usage": "传场景/蓝图 id（可附同角色 outfitId 换装，或仅传 outfitId 出服装图）；可选成对 width/height、seed、modelId、upscale，单项 ≤8 张。"
            },
            "prompt": {
                "method": "POST", "path": "/api/muse/jobs",
                "json": {"prompt":"your image prompt","requestKey":"replace-with-new-uuid"},
                "usage": "自定义 prompt（不与目录 id 混用）；可选 modelId、width/height、seed、variants；Anima 支持 upscale 与 character 自动匹配本机 LoRA。"
            },
            "batch": {
                "method": "POST", "path": "/api/muse/batches",
                "json": {"ids": ["sc041", "sc093"], "requestKey": "replace-with-new-uuid", "upscale": "remacri"},
                "usage": "传 ids 或逐项 items，整批 ≤16 张；顶层 width/height/upscale 可作批量默认并由单项覆盖。"
            },
            "queue": {"method": "GET", "path": "/api/muse/queue", "usage": "查排队位置、进度与预估时间。"},
            "uploadedInputs": {
                "method": "POST", "path": "/api/muse/inputs/lookup",
                "usage": "传 ≤16 个小写 SHA-256 数组查询可复用参考图，缺少的再经对应模型 images/raw 上传。"
            },
            "recent": {"method": "GET", "path": "/api/muse/jobs", "usage": "断线后按 items（entryType=batch|image）的 statusPath 恢复；支持 since（RFC3339 或 Unix 毫秒）。"}
        },
        "retry": "新任务用新 requestKey；断线/超时重试沿用原 requestKey 与原请求体。",
        "resultParts": {
            "partBytes": crate::images::http::PART_BYTES,
            "usage": "弱网按 resultUrl?part=0 起依次取分片，依 X-Result-Offset 写入并核对 Content-Length 与 X-Part-Sha256；集齐后校验整图 resultBytes 与 resultSha256。",
            "timing": "generationMs 为生成耗时；客户端下载耗时单独计时。"
        },
        "followup": "提交后 GET 顶层 statusPath 或 /api/muse/batches/{batchKey} 查 items 的 status/progress/resultUrl（waiting 继续查，取消发 DELETE cancelPath）。",
        "download": "GET resultUrl 保留部分文件续传（Range: bytes=N- + If-Range: ETag）；206 追加、200 替换，完成后核对 resultBytes 与 resultSha256。"
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
