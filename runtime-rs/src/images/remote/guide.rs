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
        "usage": "使用当前连接的地址和已保存的 X-Token。以下路径均相对于当前地址。",
        "sceneModels": ["anima-miaomiao-v1.6", "moss-miaomiao-base-v1.0", "moss-miaomiao-base-v1.1"],
        "quickDraw": {
            "submit": "已有目录 ID 或提示词时，直接 POST /api/muse/jobs，无需先查目录或队列。每次新任务用新 requestKey，同一次重试用原编号与原请求体。",
            "receive": "Cloudflare 中转的回执含 receivePath。能接收二进制的客户端可直接 GET 该路径；每次最多等 20 秒，202 或 pending=true 时按 Retry-After 继续同一路径。收到 PNG 后按响应中的原图长度和 SHA-256 校验。需要进度或并行下载时，GET 批次 statusPath。",
            "cli": "py tools/muse-relay/get_result.py HTTPS根地址 @request.json 成图.png --submit；它会生成缺省 requestKey，并自动提交、等待、校验和保存。断线后用已显示的 batchKey 继续取图。"
        },
        "upscale": {
            "field": "upscale", "family": "anima", "scale": 1.5,
            "ultrasharp": {"mode": "放大并重绘", "sampler": "euler", "scheduler": "normal", "steps": 10, "cfg": 5.5, "denoise": 0.8, "shift": 3},
            "remacri": {"mode": "纯放大", "steps": 0},
            "off": "关闭放大，可覆盖批量默认值。",
            "usage": "单张目录、自定义提示词及批量均可传这个字段。批量顶层应用到整批，items 内的设置优先。width 和 height 仍指放大前的画幅。"
        },
        "moss": {
            "mossSampler": ["euler", "er-sde"],
            "mossAcceleration": ["off", "spectrum", "spectrum-adaptive"],
            "mossSpectrumFlexWindow": {"min": 0, "max": 2},
            "usage": "新打包的 MOSS 目录配方使用 Euler、50 步、CFG 3.5 和 Spectrum 0.5。选择 er-sde 预览时默认用 25 步、CFG 2.5 和完整计算。单张可覆盖采样器和加速设置，整批 MOSS 可在顶层指定，items 逐项按字段覆盖。混合模型批次请把 MOSS 参数放在对应项内。",
            "canvas": "同时传 width 和 height 可调整目录画幅。目录中的元素框跟随宽、高分别缩放。自定义 prompt 使用提交时的坐标。"
        },
        "operations": {
            "desktopChat": {
                "inbox": "GET /api/muse/desktop/inbox", "reply": "POST /api/muse/desktop/reply",
                "usage": "桌面与 QQ 各自持续 GET inbox?wait=25，HTTP 超时至少 40 秒。空结果立即续接，连续出错时退避。按 conversationId 和 messages 回答，写好即在到期前用原 requestKey 和 text 回传，每个编号只生成一次。"
            },
            "qqChat": {
                "inbox": "GET /api/muse/qq/inbox", "reply": "POST /api/muse/qq/reply",
                "targets": "GET /api/muse/qq/targets", "send": "POST /api/muse/qq/send", "search": "POST /api/muse/qq/search",
                "json": {"requestKey":"收件项的 requestKey","text":"回到原会话的文字"},
                "usage": "单独持续 GET inbox?wait=25，HTTP 超时至少 40 秒。空结果立即续接，失败时退避。用 conversationId 区分会话，senderId 区分发件人。普通文字用 recentMessages 直接回答，写好即回传，同一 requestKey 只生成一次。",
                "context": "GET /api/muse/qq/context/{conversationId}。用 targets 中的群会话编号读取最近一小时内最多 64 条发言。每条群来信按绘遇的群聊前文设置附上 recentMessages，含已获 QQ 确认的 Muse 发言。",
                "groupRouting": "已启用的私聊和群 @ 消息可交给 Muse，群里也可用 /muse。普通群消息还需要机主开启接收，并且群主在 QQ 同意。绑定、帮助、取图等命令仍交给绘遇。",
                "senderIdentity": "群内按 senderId 认人，senderNickname 是显示名。只有 senderRole=owner 才称群主。admin 是管理员，member 是普通成员，unknown 表示未核实。私聊的 senderRole 为 null。",
                "image": {"mimeType":"image/jpeg 或 image/png","data":"JPEG 或 PNG 原始文件的标准 base64，原文件最多 3 MiB"},
                "audio": {"mimeType":"audio/mpeg","data":"MP3 原文件的标准 base64，原文件最多 3 MiB"},
                "delivery": "expiresAt 为 Unix 毫秒。在到期前向 reply 提交收件编号，可回一条 1–1600 字的 text 和一个附件，也可只发附件。附件选 image 或 audio。status=sent 表示 QQ 已确认。重试时沿用原编号和原内容。410 表示原消息已失效，需要发件人重新提问。",
                "skip": "普通群消息无需插话时，向 reply 或 /qq/replies 提交 {requestKey,skip:true}，返回 status=skipped，不占用 QQ 发送额度。",
                "proactive": "机主开启 museProactive 主动发送后，先 GET targets 选出已绑定的 conversationId。POST send 提交此 conversationId、新 UUID 作为 requestKey，以及 text、image 或 audio 中的一项。QQ 平台会检查机器人权限和主动消息额度。重试用同一编号和原内容。",
                "webSearch": "POST search，传原收件项的 requestKey 和 query。主动检索可用新的 UUID 作为 requestKey，并同时传已开启会话的 conversationId 和 query。结果包含 ok、query 和 results，每项是公开网页的 title、url、snippet。可将相关来源发回当前会话。",
                "vmMode": "QQ_MUSE_VM_POLL 表示 Muse 通过笔记本专用 Tailscale 端口收信。QQ_MUSE_VM_ACTIVE 表示绘遇向虚拟机 POST /qq/questions，随后 GET /qq/replies/{requestKey}。",
                "vmPoll": {"inbox":"GET /qq/pending","context":"GET /qq/context/{conversationId}","reply":"POST /qq/replies","targets":"GET /qq/targets","send":"POST /qq/send","search":"POST /qq/search"},
                "vmImageReply": "反向轮询时也可用 POST /qq/replies/{requestKey}/image 提交 JPEG 或 PNG 原始字节。Content-Type 应与文件相符，最多 3 MiB。"
            },
            "catalog": {
                "method": "GET", "path": "/api/muse/catalog",
                "query": "kind=character 查角色，kind=outfit 查服装，kind=media 查场景和蓝图。可传 search、character 和 rating（如 R18）。pageSize 最大 500，按 nextPage 翻页，ratings 列出分级。",
                "example": "/api/muse/catalog?kind=outfit&character=nene",
                "outfitSelection": "服装列表优先展示 displayTitle，它带有角色名称。同名服装可能有不同配方，换装时使用选中项的完整 id。"
            },
            "details": {
                "method": "GET", "path": "/api/muse/catalog/{kind}/{id}",
                "usage": "scene 或 blueprint 查看种子和变体。outfit 查看标签词和兼容模型，使用完整服装 ID，保留其中的斜杠。"
            },
            "draw": {
                "method": "POST", "path": "/api/muse/jobs",
                "json": {"id": "sc093", "requestKey": "replace-with-new-uuid", "upscale": "ultrasharp"},
                "usage": "传场景或蓝图 id，可加同一角色的 outfitId 换装。只传 outfitId 可独立出服装图。省略宽高使用配方画幅；也可同时传 width 和 height，按模型支持范围校验。可选 seed、modelId、upscale，每项最多 8 张。单张也返回 batchKey 和批次 statusPath。"
            },
            "prompt": {
                "method": "POST", "path": "/api/muse/jobs",
                "json": {"prompt":"your image prompt","requestKey":"replace-with-new-uuid"},
                "usage": "直接提交自定义提示词，不与目录 ID 混用。可选 modelId、宽高 width/height、seed、variants。Anima 可传 upscale，或传 character 自动匹配本机已安装的 LoRA。"
            },
            "batch": {
                "method": "POST", "path": "/api/muse/batches",
                "json": {"ids": ["sc041", "sc093"], "requestKey": "replace-with-new-uuid", "upscale": "remacri"},
                "usage": "顶层 width、height 和 upscale 可给整批设置默认尺寸与放大方式。用 items 可逐项指定场景、服装或 prompt，并覆盖宽高或 upscale。每批最多 16 张，响应含批次和每项的 statusPath。"
            },
            "queue": {"method": "GET", "path": "/api/muse/queue", "usage": "查看排位、进度和可用的时间估算。"},
            "uploadedInputs": {
                "method": "POST", "path": "/api/muse/inputs/lookup",
                "usage": "向支持 inputReuse 的出图机复用参考图。请求体为最多 16 个小写 SHA-256 字符串的数组，返回 inputs 对象，按摘要列出当前连接可用的素材文件名。缺少的素材继续通过对应模型的 images/raw 上传。"
            },
            "recent": {"method": "GET", "path": "/api/muse/jobs", "usage": "断线后先查 items；entryType=batch 表示批次，image 表示单张。按 statusPath 恢复，since 接受 RFC3339 或 Unix 毫秒。"}
        },
        "retry": "每次新出图生成新的 requestKey（推荐 UUID）。同一次提交因断线重试时，复用原请求体和原编号。",
        "resultParts": {
            "partBytes": crate::images::http::PART_BYTES,
            "usage": "弱网下从 resultUrl 加 ?part=0 开始，按编号取分片。每片响应是二进制，按 X-Result-Offset 放到对应位置，以 Content-Length 和 X-Part-Sha256 校验该片。断线、空响应或校验失败时只重取这一片。每片 X-Result-Sha256 应与回执一致。集齐 resultBytes 后核对整图 resultSha256，再交给用户。",
            "timing": "generationMs 是生成耗时；下载耗时从第一次取图到整图校验通过，由调用方另行计时。"
        },
        "followup": "提交后直接 GET 响应顶层的 statusPath，或 GET /api/muse/batches/{batchKey}。看 items 中每张图的 status、progress 和 resultUrl。收到 waiting 表示已入队，可以继续查同一路径。取消时向返回的 cancelPath 发 DELETE。旧版单图仍可沿原回执路径读取 job。",
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
