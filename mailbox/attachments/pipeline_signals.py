"""Read-only signals for the QQ and desktop dashboard. All timestamps are Unix ms."""

from collections.abc import Mapping
from http.client import HTTPException
from time import time_ns
from urllib.error import HTTPError


def now_ms():
    return time_ns() // 1_000_000


def probe_relay(get_json):
    """Use the calling bridge's authenticated GET, with its own origin, proxy and timeout."""
    online = None
    last_seen = None
    try:
        data = get_json("/api/muse/connection")
        if not isinstance(data, Mapping) or data.get("ok") is not True:
            reason = "invalid_response"
        elif type(data.get("laptopOnline")) is not bool:
            reason = "unsupported_response"
        else:
            online = data["laptopOnline"]
            stamp = data.get("lastSeenAt")
            last_seen = stamp if type(stamp) is int and stamp > 0 else None
            reason = None
    except HTTPError as error:
        reason = f"http_{error.code}"
        error.close()
    except (OSError, HTTPException):
        reason = "transport_error"
    except ValueError:
        reason = "invalid_response"
    return {"observedAt": now_ms(), "online": online, "lastSeenAt": last_seen, "reason": reason}


def fresh(stamp, now, max_age_ms):
    return type(stamp) is int and 0 <= now - stamp <= max_age_ms


def connector_node(sample, *, direct=False, at=None, max_age_ms=75_000):
    """Pass the last probe for this connection only. A failed probe replaces a successful probe."""
    if direct:
        return {"state": "unknown", "label": "直连 · 无中转心跳"}
    now = now_ms() if at is None else at
    if not sample:
        return {"state": "unknown", "label": "尚无连接观测"}
    if not fresh(sample.get("observedAt"), now, max_age_ms):
        return {"state": "unknown", "label": "连接观测已过时"}
    if sample.get("online") is True:
        return {"state": "online", "label": "连接器在线"}
    if sample.get("online") is False:
        if sample.get("lastSeenAt") is None:
            return {"state": "unknown", "label": "中转尚未见到连接器"}
        return {"state": "offline", "label": "连接器心跳中断"}
    reason = sample.get("reason")
    labels = {
        "http_401": "探针密钥未通过",
        "http_403": "探针访问被拒",
        "http_404": "此地址无连接探针",
    }
    return {"state": "unknown", "label": labels.get(reason, "连接状态未知"), "reason": reason}


def intake_edge(*, completed_at=None, ok=None, http_status=None, at=None, max_age_ms=90_000):
    """Use the last completed inbox call for this channel, including an empty 200."""
    now = now_ms() if at is None else at
    if not fresh(completed_at, now, max_age_ms):
        return {"state": "unknown", "label": "暂无近期取件记录"}
    if ok is True:
        return {"state": "ok", "label": "取件正常"}
    if ok is False:
        detail = f" · HTTP {http_status}" if type(http_status) is int else ""
        return {"state": "error", "label": "取件失败" + detail}
    return {"state": "unknown", "label": "取件结果未知"}


def delivery_view(channel, *, receipt=None, phase=None, code=None, via="reply"):
    """Project one (channel, requestKey). Supply its durable receipt and current sender phase.

    phase: ready / posting / retry / uncertain / expired / rejected / skipped.
    posting means a live POST, not simply the existence of an old firstPostAt.
    code belongs to the latest attempt. Clear it when a new attempt starts.
    """
    if channel not in ("qq", "desktop"):
        raise ValueError("channel must be qq or desktop")
    status = receipt.get("status") if isinstance(receipt, Mapping) else None
    if (channel, status) == ("qq", "sent"):
        state, label = "confirmed", "QQ 已确认"
    elif (channel, status) == ("desktop", "accepted"):
        state, label = "confirmed", "桌面已接收"
    elif (channel, status) == ("qq", "skipped"):
        state, label = "skipped", "已确认跳过"
    elif phase == "uncertain" or code == "QQ_MUSE_SEND_UNCERTAIN":
        state, label = "uncertain", "送达待核对"
    elif phase == "expired":
        state, label = "expired", "回复窗口已关闭"
    elif channel == "qq" and code == "QQ_AUDIT_PENDING":
        state, label = "audit", "QQ 审核中"
    elif channel == "qq" and via == "send" and code == "QQ_MUSE_SEND_PENDING":
        state, label = "preparing", "网关正在准备发送"
    else:
        stages = {
            "awaiting_answer": ("awaiting_answer", "待答 · 认领状态未知"),
            "answering": ("answering", "已认领，正在答题"),
            "ready": ("queued", "等待发送"),
            "posting": ("posting", "正在提交，等待回执"),
            "retry": ("retry", "等待重试"),
            "rejected": ("rejected", "发送被拒"),
            "skipped": ("local_skip", "已选择跳过，尚无确认"),
            "fallback": ("fallback", "原回复已转补发"),
            "lost": ("lost", "本地已标记丢单"),
            "marked_done": ("marked_done", "本地有完成标记"),
            "marked_skip": ("marked_skip", "本地记录为跳过"),
        }
        state, label = stages.get(phase, ("unknown", "暂无发送观测"))
    return {"state": state, "label": label, "moving": state == "posting"}


def channel_traffic(channel, rows_by_key):
    """Count current work from one channel's complete, receipt-merged map, before pagination.

    Each value has the delivery_view inputs plus two local phases: queued and answering.
    Pass None when the collector has no snapshot. Zero requires an actual empty map.
    """
    if rows_by_key is None:
        return None
    counts = dict.fromkeys(("awaiting_answer", "queued", "answering", "ready", "posting", "retry",
                            "preparing", "audit", "uncertain", "unknown"), 0)
    for row in rows_by_key.values():
        phase = row.get("phase")
        delivery = delivery_view(channel, receipt=row.get("receipt"), phase=phase,
                                 code=row.get("code"), via=row.get("via", "reply"))
        state = delivery["state"]
        if state == "unknown" and phase in ("queued", "answering"):
            counts[phase] += 1
        elif state == "queued":  # A reply exists in the outbox.
            counts["ready"] += 1
        elif state in counts:
            counts[state] += 1
    # A delivery awaiting manual reconciliation has no known transfer in progress.
    active = sum(counts[name] for name in
                 ("awaiting_answer", "queued", "answering", "ready", "posting", "retry", "preparing", "audit"))
    return {**counts, "inFlight": active}
