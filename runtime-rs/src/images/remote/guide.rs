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
    let operations = json!({
        "desktopChat": {
            "inbox": "GET /api/muse/desktop/inbox", "reply": "POST /api/muse/desktop/reply",
            "usage": "GET inbox?wait=25（HTTP 超时 ≥40s）；空收件箱立即续接，异常退避。按 conversationId 和 messages 回答，expiresAt 前凭原 requestKey 与 text 回传。重试沿用完整回复。",
            "drawing": "用户要出图且来信 drawingAllowed=true 时可附 drawing，使用批次的 ids 或 items 参数，省略 requestKey。桌面在原对话显示出图进度和成图。"
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
        "interrogate": {
            "status": "GET /api/muse/interrogate/status",
            "run": "POST /api/muse/interrogate",
            "usage": "图像反推（PixAI + 可选宿主视觉协同与 assistLayout 布局框，默认按图片 SHA-256 与参数/通道启用内存+本地 SQLite 持久化结果缓存，14 天过期，仅缓存成功结果，命中时返回 cacheHit:true）。直连支持原始字节（≤20 MiB）加 query 参数（mode/threshold/assist/subjectMode/layout/noCache）；中转使用 application/json 传 requestKey、imageBase64（≤8 MiB）及同款控制字段（HTTP 超时 ≥110s）。"
        },
        "upscale": {
            "method": "POST", "path": super::muse::upscale::UPSCALE_PATH,
            "usage": "独立放大单张图（initImage 或 ≤8 MiB imageBase64），返回标准 Muse 批次，经 statusPath/resultUrl 校验下载。"
        },
        "video": {
            "status": "GET /api/muse/video/status",
            "preview": "POST /api/muse/video/prompt/preview",
            "inputs": "POST /api/muse/video/inputs",
            "jobs": "POST /api/muse/video/jobs",
            "job": "GET|DELETE /api/muse/video/jobs/{id}",
            "jobResult": "GET|HEAD /api/muse/video/jobs/{id}/result",
            "request": "GET|DELETE /api/muse/video/requests/{key}",
            "batches": "POST /api/muse/video/batches",
            "batch": "GET|DELETE /api/muse/video/batches/{id}",
            "batchResult": "GET|HEAD /api/muse/video/batches/{id}/result",
            "concat": "POST /api/muse/video/batches/{id}/concat",
            "retry": "POST /api/muse/video/batches/{id}/retry",
            "batchRequest": "GET|DELETE /api/muse/video/batch-requests/{key}",
            "partBytes": crate::video::muse::PART_BYTES,
            "maxPartCount": crate::video::muse::MAX_PART_COUNT,
            "usage": "素材上传直连支持 octet-stream（≤20 MiB）+?kind=，中转支持 JSON {kind?,mimeType,data}（原文件 ≤3 MiB）；成片直连支持 Range，中转按 ?part=N&count=M（1..=16）逐片下载并核对 X-Part-Sha256 与 X-Result-Sha256。"
        },
        "health": {
            "method": "GET", "path": "/api/muse/health",
            "usage": "严格只读查询出图/视频/反推/语音/聊天/作品册在线状态、可用模型数量与能力开关。"
        },
        "gallery": {
            "list": "GET /api/muse/gallery",
            "item": "GET /api/muse/gallery/{id}",
            "file": "GET|HEAD /api/muse/gallery/{id}/file",
            "partBytes": super::ops::PART_BYTES,
            "maxPartCount": super::ops::MAX_PART_COUNT,
            "usage": "严格只读查询桌面作品册（支持 page/pageSize≤50/kind/character/search/favorite/tag/engine/model/reviewState）；详情与下载可选 ?idType=string|number，中转下载使用 ?part=N&count=M 并核对 SHA-256。"
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
        "options": {
            "method": "GET", "path": super::muse::companion::OPTIONS_PATH,
            "usage": "查询已安装模型（含 keyframe/manga-screen）、默认参数和尺寸、图生图/蒙版/参考图/MOSS 布局能力、可用 LoRA 与放大权重。可传 modelId 或 character 筛选。"
        },
        "draw": {
            "method": "POST", "path": "/api/muse/jobs",
            "json": {"id": "sc093", "requestKey": "replace-with-new-uuid", "teaCacheThresh": 0.06},
            "usage": "传场景/蓝图 id（可附同角色 outfitId 换装，或仅传 outfitId 出服装图，或传 cast 1–5 人混搭同框）；支持 anima/moss/krea2 目录配方，以及图生图/参考图/蒙版/构图控制参数，单项 ≤8 张。"
        },
        "prompt": {
            "method": "POST", "path": "/api/muse/jobs",
            "json": {"prompt":"your image prompt","requestKey":"replace-with-new-uuid"},
            "usage": "自定义 prompt（不与目录 id 混用；多角色同框请用 cast）；可选 modelId（含 keyframe/manga-screen）、width/height、seed、variants、图生图/参考图/蒙版/MOSS 布局；Anima 支持 TeaCache、upscale 与单角色 character 自动匹配本机 LoRA。"
        },
        "multiCast": {
            "method": "POST", "path": "/api/muse/jobs",
            "json": {"modelId": "moss-miaomiao-base-v1.1", "cast": [{"characterId": "nene", "outfitId": "studio/nene-school"}, {"characterId": "natsume", "outfitId": "studio/natsume-cafe"}], "formation": "row", "prompt": "sunny cafe window", "requestKey": "replace-with-new-uuid"},
            "usage": "1–5 人多角色混搭同框构图（支持画室角色 nene/natsume 与目录任意热门角色自由混搭）。每个成员传 characterId、可选 outfitId/outfitExplicit/action；可选 formation（row|staggered，4–5 人支持前后排错落）、共享场景 prompt、目录 scene/blueprint id，以及 MOSS 参考图 layout（assistLayout 人物框数 ≥ 角色数时按面积与从左到右自动绑定）。Anima 自动走无角色 LoRA + BREAK 分段与从左到右站位编译；MOSS 自动编译规范 abs_centralized/yxyx 多人布局；Krea 2/Qwen/Keyframe 编译英文自然语言多人同框。"
        },
        "batch": {
            "method": "POST", "path": "/api/muse/batches",
            "json": {"ids": ["sc041", "sc093"], "requestKey": "replace-with-new-uuid", "upscale": "remacri"},
            "usage": "传 ids 或逐项 items，整批 ≤16 张；顶层 width/height/upscale、teaCache/teaCacheThresh 可作批量默认并由单项覆盖。"
        },
        "queue": {"method": "GET", "path": "/api/muse/queue", "usage": "查排队位置、进度与预估时间。"},
        "uploadedInputs": {
            "method": "POST", "path": "/api/muse/inputs/lookup",
            "usage": "传 ≤16 个小写 SHA-256 数组查询可复用参考图，缺少的再经对应模型 /api/{family}/images/raw 上传。"
        },
        "recent": {"method": "GET", "path": "/api/muse/jobs", "usage": "按 statusPath 恢复任务。支持 since（RFC3339 或 Unix 毫秒）、agent 和 status。筛选后空页也可能有 nextBefore。"}
    });
    json!({
        "name": "绘遇远程出图",
        "protocol": "huiyu-muse",
        "version": 3,
        "guidePath": PATH,
        "authHeader": "X-Token",
        "agentTools": {
            "cli": "cli-anything-huiyu --json help",
            "functionCalling": "cli-anything-huiyu --json help invoke 返回 huiyu_drawing 的函数定义；将函数参数写入 cli-anything-huiyu --json invoke 的标准输入。",
            "handoff": "共享 batchKey 交接同一任务。requestKey 可用 助手名_UUID；重试沿用原编号和完整请求体。",
            "history": "GET /api/muse/jobs",
            "batch": "GET /api/muse/batches/{batchKey}",
            "errors": "批次看 items[].status、code、error；经中转还可看 deliveryStatus。历史中 failedCount 大于 0 的批次可按编号查询明细。"
        },
        "usage": "使用当前地址、X-Token 与以下相对路径；新任务生成新 UUID requestKey，重试沿用原编号与原请求体。",
        "sceneModels": ["anima-miaomiao-v1.6", "moss-miaomiao-base-v1.0", "moss-miaomiao-base-v1.1", "krea2-turbo", "krea2-raw"],
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
            "usage": "单张、自定义及批量均可用；items 优先于顶层默认值。width/height 传放大前尺寸。已有图片独立放大请用 POST /api/muse/upscale。"
        },
        "standaloneUpscale": {
            "method": "POST", "path": super::muse::upscale::UPSCALE_PATH,
            "upscalers": ["remacri", "ultrasharp"],
            "maxBase64Bytes": super::muse::upscale::MAX_BASE64_IMAGE_BYTES,
            "usage": "异步返回标准 Muse 批次（202）。二选一传已上传 initImage（别名 imageId）或 imageBase64（≤8 MiB）；原图宽高须 512–1536 且为 16 倍数。remacri 1.5×/2.0× 走原生像素放大，ultrasharp 或自定义倍率走 Anima 高清重绘。"
        },
        "teaCache": {
            "family": "anima",
            "teaCache": {"type": "boolean", "default": true},
            "teaCacheThresh": {"min": 0, "max": 1, "default": 0.1},
            "usage": "目录或自定义出图均可用。省略时沿用模型或配方默认值；false 或阈值 0 停用加速。整批可传顶层默认值，每项可覆盖；混合模型时只在 Anima 项内传。"
        },
        "moss": {
            "mossSampler": ["euler", "er-sde"],
            "mossAcceleration": ["off", "spectrum", "spectrum-adaptive"],
            "mossSpectrumFlexWindow": {"min": 0, "max": 2},
            "usage": "默认 Euler、50 步、CFG 3.5、Spectrum 0.5；er-sde 预览默认 25 步、CFG 2.5、完整计算。支持整批顶层设置与 items 单项覆盖（混合批次放对应项内）。",
            "canvas": "同时传 width/height 调整画幅，目录元素框按宽高比例缩放。",
            "mossLayout": "自定义布局支持在 prompt 传 JSON/```json``` 或显式传 layout 对象（自动支持 normalized/rel_0_1、rel_1000、abs/xyxy 与 abs_centralized/yxyx 四种坐标并换算校验为规范像素框，1–16 项，支持 assistLayout 直通）。"
        },
        "krea2": {
            "models": ["krea2-turbo", "krea2-raw"],
            "usage": "支持目录场景/蓝图/服装配方（动态编译英文自然语言并匹配最接近宽高比），可选 styleLoraId；不支持 negative 与 initImage。"
        },
        "img2img": {
            "anima": "支持 initImage（别名 imageId）、denoisingStrength（0.1–1.0）、maskImage 或 maskPrompt（二选一，含 maskThreshold/growMaskBy）、sketchControl、regions（≤4 区域）。",
            "qwen": "支持 initImage 与最多 3 张 referenceImages（总计 ≤4 张）。",
            "keyframe": "模型 flux-kontext-dev / minimax-h3-image-q4，必填 initImage，可选 ≤3 张 referenceImages，画幅 512–1024（32 倍数，默认 1024x1024）。",
            "manga": "modelId=manga-screen（或 kind=manga），必填 initImage，支持 operation（默认 lite）、penLines、penLinesPolarity、penLinesFit、autoLines、levels、finish、panel、rewrite；仅 variants=1，直连支持 /api/manga/jobs/{id}/lineart。"
        },
        "operations": operations,
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
