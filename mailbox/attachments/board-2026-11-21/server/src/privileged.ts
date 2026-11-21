// Privileged host handlers for the message board.
//
// The board's data lives in the two bridges' local files on this
// machine (~/workspace/qq-bridge, ~/workspace/desktop-bridge, state
// markers under ~/hooks/state). Reading them used to go through a
// spawned agent reader task, which took minutes per refresh — the
// board could never be real-time. This handler does the same
// normalization deterministically in a short python3 run (stdlib
// only, read-only, no network), so a refresh completes in well
// under a second and the 1-minute schedule + the open page's 15s
// auto-refresh actually track the bridges live.
//
// Derivation rules (all from records, nothing invented):
// - delivered: a pool `sent` event is authoritative even if the
//   outbox was later overwritten by a skip; a sent-* marker alone is
//   not (the shipper also marks processed skip files), so an outbox
//   skip beats a bare marker.
// - replying vs queued: a claimed/<key>.claim file means a worker
//   has picked the message up (several can be claimed at once since
//   the bridges answer with up to 3 parallel workers).
// - fetchedAtMs = claim time when a claim exists, else the inbox
//   file time — so the first timing segment is the real wait for a
//   worker, not a ~0s file-write artifact.
// - firstSentAtMs = earliest attempts.jsonl entry for the key.
// - reviewPending: only QQ proactive sends whose ledger/receipt
//   records mention platform review; never on ordinary replies.
// - Desktop text comes ONLY from the inbox `text` field; the
//   `messages` array (character system prompt) is never read out.

import { execFile } from "node:child_process";
import {
  definePrivilegedContracts,
  definePrivilegedHandlers,
  z,
} from "@hatch/space-sdk";

export const privileged = definePrivilegedContracts({
  readBridgeSnapshot: {
    request: z.object({}),
    response: z.object({
      messages: z.array(
        z.object({
          channel: z.enum(["qq", "desktop"]),
          requestKey: z.string(),
          conversationId: z.string().nullable(),
          conversationLabel: z.string().nullable(),
          senderName: z.string().nullable(),
          senderRole: z.string().nullable(),
          kind: z.enum(["reply", "proactive"]),
          text: z.string(),
          attachments: z.array(z.string()),
          status: z.enum([
            "queued",
            "replying",
            "waiting_send",
            "delivered",
            "skipped",
            "expired",
            "failed",
          ]),
          statusReason: z.string().nullable(),
          reasonSource: z
            .enum(["recorded", "inferred", "unknown"])
            .nullable(),
          replyText: z.string().nullable(),
          replyAttachments: z.array(z.string()),
          receivedAtMs: z.number().nullable(),
          fetchedAtMs: z.number().nullable(),
          repliedAtMs: z.number().nullable(),
          deliveredAtMs: z.number().nullable(),
          firstSentAtMs: z.number().nullable(),
          reviewPending: z.boolean(),
          expiresAtMs: z.number().nullable(),
          receivedDerived: z.boolean(),
        }),
      ),
      health: z.array(
        z.object({
          channel: z.enum(["qq", "desktop"]),
          lastFetchStatus: z.string().nullable(),
          lastFetchAtMs: z.number().nullable(),
          detail: z.string().nullable(),
        }),
      ),
      readerNote: z.string().nullable(),
      // Pipeline signal maintained by the bridges' collectors in
      // ~/workspace/bridge-tools/board-status.json (regenerated every
      // few seconds): sampledAtMs is its generatedAt; lanes carry the
      // gateway node signal, the intake edge, and per-stage counts.
      // rowDelivery carries each row's own delivery verdict
      // (rows[].delivery: state + label, keyed by requestKey) — the
      // delivery engine's terminal "uncertain" （送达待核对） state
      // rides here so the page can settle a row whose bridge status
      // is still waiting_send.
      pipeline: z
        .object({
          sampledAtMs: z.number().nullable(),
          rowDelivery: z.record(
            z.string(),
            z.object({ state: z.string(), label: z.string() }),
          ),
          lanes: z.object({
            qq: z
              .object({
                node: z
                  .object({ state: z.string(), label: z.string() })
                  .nullable(),
                intake: z
                  .object({ state: z.string(), label: z.string() })
                  .nullable(),
                counts: z.object({
                  awaiting_answer: z.number(),
                  queued: z.number(),
                  answering: z.number(),
                  ready: z.number(),
                  posting: z.number(),
                  retry: z.number(),
                  preparing: z.number(),
                  audit: z.number(),
                  uncertain: z.number(),
                  unknown: z.number(),
                  inFlight: z.number(),
                }),
              })
              .nullable(),
            desktop: z
              .object({
                node: z
                  .object({ state: z.string(), label: z.string() })
                  .nullable(),
                intake: z
                  .object({ state: z.string(), label: z.string() })
                  .nullable(),
                counts: z.object({
                  awaiting_answer: z.number(),
                  queued: z.number(),
                  answering: z.number(),
                  ready: z.number(),
                  posting: z.number(),
                  retry: z.number(),
                  preparing: z.number(),
                  audit: z.number(),
                  uncertain: z.number(),
                  unknown: z.number(),
                  inFlight: z.number(),
                }),
              })
              .nullable(),
          }),
        })
        .nullable(),
    }),
    timeoutMs: 30_000,
  },
});

type SnapshotOut = z.infer<
  (typeof privileged)["readBridgeSnapshot"]["response"]
>;

const READER_PY = String.raw`
import glob
import json
import os
import re
import time

HOME = "/home/hatch"
QQ_DIR = f"{HOME}/workspace/qq-bridge"
QQ_STATE = f"{HOME}/hooks/state/qq-bridge"
DT_DIR = f"{HOME}/workspace/desktop-bridge"
DT_STATE = f"{HOME}/hooks/state/desktop-bridge"
NOW = int(time.time() * 1000)


def mtime_ms(path):
    try:
        return int(os.path.getmtime(path) * 1000)
    except OSError:
        return None


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def trunc(s, n):
    if s is None:
        return None
    s = str(s)
    return s if len(s) <= n else s[:n]


def markers(state_dir, prefix):
    out = {}
    for p in glob.glob(os.path.join(state_dir, prefix + "*")):
        key = os.path.basename(p)[len(prefix):]
        out[key] = mtime_ms(p)
    return out


def claims(bridge_dir):
    out = {}
    for p in glob.glob(os.path.join(bridge_dir, "claimed", "*.claim")):
        key = os.path.basename(p)[:-len(".claim")]
        out[key] = mtime_ms(p)
    return out


def first_attempts(bridge_dir):
    out = {}
    path = os.path.join(bridge_dir, "attempts.jsonl")
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                key, at = ev.get("key"), ev.get("at")
                if key and isinstance(at, (int, float)):
                    at = int(at)
                    if key not in out or at < out[key]:
                        out[key] = at
    except OSError:
        pass
    return out


def review_keys(bridge_dir):
    out = set()
    for name in ("attempts.jsonl", "receipts.jsonl"):
        path = os.path.join(bridge_dir, name)
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    if "review" not in line and "审核" not in line:
                        continue
                    try:
                        ev = json.loads(line)
                    except Exception:
                        continue
                    blob = json.dumps(ev, ensure_ascii=False)
                    if "review" in blob or "审核" in blob:
                        if ev.get("key"):
                            out.add(ev["key"])
        except OSError:
            pass
    return out


def health(channel, log_path):
    lines = []
    try:
        with open(log_path, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return {
            "channel": channel,
            "lastFetchStatus": None,
            "lastFetchAtMs": None,
            "detail": trunc("读取不到桥的 relay.log，健康状态未知", 500),
        }
    tail = [ln for ln in lines[-40:] if ln.strip()]
    last_err = None
    last_err_idx = -1
    last_ok_idx = -1
    err_count = 0
    for i, ln in enumerate(tail):
        m = re.search(r"fetch_error:([A-Za-z0-9_]+)", ln)
        if m:
            last_err = m.group(1)
            last_err_idx = i
            err_count += 1
        if "pool_sync_new" in ln or "reply_shipped" in ln or "send_shipped" in ln:
            last_ok_idx = i
    if last_err is not None and last_err_idx > last_ok_idx:
        status = last_err
        detail = f"最近{len(tail)}行内{err_count}次 fetch_error:{last_err}，最新一次取信仍失败"
    elif tail:
        status = "ok"
        detail = f"最近{len(tail)}行日志无取信失败" + (
            f"（更早有 {err_count} 次 fetch_error）" if err_count else ""
        )
    else:
        status = None
        detail = "relay.log 为空，暂无轮询记录"
    return {
        "channel": channel,
        "lastFetchStatus": status,
        "lastFetchAtMs": mtime_ms(log_path),
        "detail": trunc(detail, 500),
    }


def att_types(items):
    out = []
    for a in items or []:
        if isinstance(a, dict):
            t = a.get("mimeType") or a.get("type") or a.get("kind")
            if t:
                out.append(str(t)[:64])
        elif isinstance(a, str):
            out.append(a[:64])
    return out[:8]


def outbox_atts(ob):
    out = []
    if ob.get("imagePath"):
        out.append("image")
    if ob.get("audioPath"):
        out.append("audio")
    return out


def qq_rows(notes):
    rows = []
    members = load_json(os.path.join(QQ_DIR, "members.json")) or {}
    group_label = members.get("group") or "宁宁测试"
    member_by_id = members.get("members") or {}

    pool = {}
    try:
        with open(os.path.join(QQ_DIR, "pool.jsonl"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                key = ev.get("key")
                if key:
                    pool.setdefault(key, {})[ev.get("kind")] = ev
    except OSError:
        notes.append("QQ pool.jsonl 读取不到，送达判定只靠状态标记")

    sent_mk = markers(QQ_STATE, "sent-")
    sent_mk = {k: v for k, v in sent_mk.items() if not k.startswith("send-")}
    send_mk = markers(QQ_STATE, "sent-send-")
    fallback_mk = markers(QQ_STATE, "fallback-")
    claim_map = claims(QQ_DIR)
    attempts = first_attempts(QQ_DIR)
    reviews = review_keys(QQ_DIR)
    if not attempts:
        notes.append("QQ attempts.jsonl 暂无发送尝试记录，firstSentAtMs 为空")

    for path in glob.glob(os.path.join(QQ_DIR, "inbox", "*.json")):
        d = load_json(path)
        if not d:
            continue
        key = d.get("requestKey") or os.path.basename(path)[:-5]
        inbox_mt = mtime_ms(path)
        expires = d.get("expiresAt")
        expires = int(expires) if isinstance(expires, (int, float)) else None
        ts = d.get("timestamp")
        derived = False
        if isinstance(ts, (int, float)) and ts > 0:
            received = int(ts)
        elif expires:
            received = expires - 300000
            derived = True
        else:
            received = inbox_mt
            derived = True
        sender_id = d.get("senderId") or ""
        member = member_by_id.get(sender_id) or {}
        pev = pool.get(key) or {}
        recv_ev = pev.get("recv") or {}
        sender_name = (
            d.get("senderNickname")
            or recv_ev.get("who")
            or member.get("nickname")
            or "?"
        )
        sender_role = d.get("senderRole") or recv_ev.get("role") or member.get("role") or ""
        ob_path = os.path.join(QQ_DIR, "outbox", key + ".json")
        ob = load_json(ob_path) if os.path.exists(ob_path) else None
        ob_mt = mtime_ms(ob_path) if ob is not None else None
        is_skip = bool(ob and ob.get("skip") is True)
        ob_text = (ob or {}).get("text") or None
        pool_sent = pev.get("sent")
        sent_at = sent_mk.get(key)
        claimed_at = claim_map.get(key)
        fetched = claimed_at if claimed_at else inbox_mt

        status = None
        delivered_at = None
        replied_at = None
        reply_text = None
        reply_atts = []
        reason = None
        reason_src = None

        # Precedence: a pool 'sent' event is authoritative even if the
        # outbox was later overwritten by a skip; a sent-* marker alone
        # is not (the shipper also marks processed skip files), so an
        # outbox skip beats a bare marker.
        if pool_sent or (sent_at and not is_skip):
            status = "delivered"
            delivered_at = sent_at or int(pool_sent.get("ts"))
            if ob_text:
                reply_text = ob_text
                reply_atts = outbox_atts(ob)
                if ob_mt and delivered_at and ob_mt <= delivered_at:
                    replied_at = ob_mt
                elif pool_sent:
                    replied_at = int(pool_sent.get("ts"))
            elif pool_sent:
                reply_text = pool_sent.get("text") or None
                reply_atts = att_types(pool_sent.get("att"))
                replied_at = int(pool_sent.get("ts"))
        elif is_skip:
            status = "skipped"
            skipped_ev = pev.get("skipped") or {}
            replied_at = ob_mt or (
                int(skipped_ev["ts"]) if skipped_ev.get("ts") else None
            )
            text_now = d.get("text") or ""
            member_notes = " ".join(member.get("notes") or [])
            if text_now.startswith("<faceType"):
                reason, reason_src = "纯表情/贴图，没有可接的话题", "inferred"
            elif "nsfw" in text_now.lower():
                reason, reason_src = "群内不发此类图，平台审核也会拦", "inferred"
            elif "已过 5 分钟有效期" in member_notes or "已过有效期" in member_notes:
                reason, reason_src = "唤醒时已过 5 分钟回复有效期", "recorded"
            else:
                reason, reason_src = None, "unknown"
        elif key in fallback_mk or (expires and NOW > expires and not ob_text):
            if expires and NOW > expires:
                status = "expired"
                reason = "超过 5 分钟回复有效期仍未写出回复"
                reason_src = (
                    "recorded"
                    if (key in fallback_mk or pev.get("expired"))
                    else "inferred"
                )
            elif ob_text:
                status = "waiting_send"
                replied_at = ob_mt
            else:
                status = "replying" if claimed_at else "queued"
        elif ob_text:
            status = "waiting_send"
            replied_at = ob_mt
        elif pev.get("expired"):
            status = "expired"
            reason = "超过 5 分钟回复有效期仍未写出回复"
            reason_src = "recorded"
        else:
            status = "replying" if claimed_at else "queued"

        rows.append({
            "channel": "qq",
            "requestKey": key,
            "conversationId": trunc(d.get("conversationId"), 256),
            "conversationLabel": trunc(group_label, 128),
            "senderName": trunc(sender_name, 128),
            "senderRole": trunc(sender_role, 32) or "",
            "kind": "reply",
            "text": trunc(d.get("text") or "", 4000),
            "attachments": att_types(d.get("attachments")),
            "status": status,
            "statusReason": trunc(reason, 500),
            "reasonSource": reason_src,
            "replyText": trunc(reply_text, 4000),
            "replyAttachments": reply_atts[:8],
            "receivedAtMs": received,
            "fetchedAtMs": fetched,
            "repliedAtMs": replied_at,
            "deliveredAtMs": delivered_at,
            "firstSentAtMs": attempts.get(key),
            "reviewPending": False,
            "expiresAtMs": expires,
            "receivedDerived": derived,
        })

    for path in glob.glob(os.path.join(QQ_DIR, "sendbox", "*.json")):
        d = load_json(path)
        if not d:
            continue
        key = d.get("requestKey") or os.path.basename(path)[:-5]
        atts = outbox_atts(d)
        if key in send_mk:
            status = "delivered"
            delivered_at = send_mk[key]
        else:
            status = "waiting_send"
            delivered_at = None
        rows.append({
            "channel": "qq",
            "requestKey": key,
            "conversationId": trunc(d.get("conversationId"), 256),
            "conversationLabel": trunc(group_label, 128),
            "senderName": None,
            "senderRole": None,
            "kind": "proactive",
            "text": trunc(d.get("text") or "", 4000),
            "attachments": atts,
            "status": status,
            "statusReason": None,
            "reasonSource": None,
            "replyText": None,
            "replyAttachments": [],
            "receivedAtMs": None,
            "fetchedAtMs": mtime_ms(path),
            "repliedAtMs": None,
            "deliveredAtMs": delivered_at,
            "firstSentAtMs": attempts.get(key),
            "reviewPending": key in reviews,
            "expiresAtMs": None,
            "receivedDerived": False,
        })
    return rows


def desktop_rows(notes):
    rows = []
    sent_mk = markers(DT_STATE, "sent-")
    lost_mk = markers(DT_STATE, "lost-")
    claim_map = claims(DT_DIR)
    attempts = first_attempts(DT_DIR)
    for path in glob.glob(os.path.join(DT_DIR, "inbox", "*.json")):
        d = load_json(path)
        if not d:
            continue
        key = d.get("requestKey") or os.path.basename(path)[:-5]
        inbox_mt = mtime_ms(path)
        expires_raw = d.get("expiresAt")
        try:
            expires = int(expires_raw) if expires_raw is not None else None
        except (TypeError, ValueError):
            expires = None
        ob_path = os.path.join(DT_DIR, "outbox", key + ".json")
        ob = load_json(ob_path) if os.path.exists(ob_path) else None
        ob_mt = mtime_ms(ob_path) if ob is not None else None
        ob_text = (ob or {}).get("text") or None
        claimed_at = claim_map.get(key)
        fetched = claimed_at if claimed_at else inbox_mt

        status = None
        delivered_at = None
        replied_at = None
        reply_text = None
        reason = None
        reason_src = None
        if key in sent_mk:
            status = "delivered"
            delivered_at = sent_mk[key]
            reply_text = ob_text
            if ob_mt and delivered_at and ob_mt <= delivered_at:
                replied_at = ob_mt
        elif key in lost_mk:
            status = "expired"
            reason = "桌面端没有主动补发通道，过期回复已记录为丢失"
            reason_src = "recorded"
            replied_at = ob_mt
        elif ob_text:
            if expires and NOW > expires:
                status = "expired"
                reason = "桌面端没有主动补发通道，过期回复已记录为丢失"
                reason_src = "inferred"
                replied_at = ob_mt
            else:
                status = "waiting_send"
                replied_at = ob_mt
        elif expires and NOW > expires:
            status = "expired"
            reason = "超过回复有效期仍未写出回复"
            reason_src = "inferred"
        else:
            status = "replying" if claimed_at else "queued"

        rows.append({
            "channel": "desktop",
            "requestKey": key,
            "conversationId": trunc(d.get("conversationId"), 256),
            "conversationLabel": "宁宁 · 桌面端",
            "senderName": None,
            "senderRole": None,
            "kind": "reply",
            "text": trunc(d.get("text") or "", 4000),
            "attachments": [],
            "status": status,
            "statusReason": trunc(reason, 500),
            "reasonSource": reason_src,
            "replyText": trunc(reply_text, 4000),
            "replyAttachments": [],
            "receivedAtMs": inbox_mt,
            "fetchedAtMs": fetched,
            "repliedAtMs": replied_at,
            "deliveredAtMs": delivered_at,
            "firstSentAtMs": attempts.get(key),
            "reviewPending": False,
            "expiresAtMs": expires,
            "receivedDerived": True,
        })
    return rows


COUNT_KEYS = (
    "awaiting_answer", "queued", "answering", "ready", "posting",
    "retry", "preparing", "audit", "uncertain", "unknown", "inFlight",
)


def pipeline_signal(notes):
    # The collectors maintain board-status.json next to the bridge
    # tools; it is the chain diagram's signal source (gateway node,
    # intake edge, per-stage counts, sample time). Read-only pass-
    # through with shape normalization — nothing derived here.
    d = load_json(f"{HOME}/workspace/bridge-tools/board-status.json")
    if not isinstance(d, dict):
        notes.append("board-status.json 读取不到，链路图信号暂缺")
        return None

    def sig(x):
        if isinstance(x, dict) and x.get("label"):
            return {
                "state": str(x.get("state") or "unknown"),
                "label": trunc(x.get("label"), 128),
            }
        return None

    def lane(x):
        if not isinstance(x, dict):
            return None
        c = x.get("counts") or {}
        counts = {}
        for k in COUNT_KEYS:
            v = c.get(k)
            counts[k] = int(v) if isinstance(v, (int, float)) else 0
        return {"node": sig(x.get("node")), "intake": sig(x.get("intake")),
                "counts": counts}

    lanes_in = d.get("lanes") or {}
    gen = d.get("generatedAt")
    sampled = int(gen) if isinstance(gen, (int, float)) and gen > 0 else None
    # Per-row delivery verdicts (rows[].delivery), keyed by
    # requestKey: pass-through of the collectors' own judgment —
    # notably state "uncertain" （送达待核对）, which is terminal in
    # the delivery engine while the row's bridge status may still
    # read waiting_send.
    row_delivery = {}
    for r in d.get("rows") or []:
        if not isinstance(r, dict):
            continue
        key = r.get("requestKey")
        dv = r.get("delivery")
        if key and isinstance(dv, dict) and dv.get("state"):
            row_delivery[str(key)] = {
                "state": str(dv.get("state")),
                "label": trunc(dv.get("label") or "", 128) or "",
            }
    return {
        "sampledAtMs": sampled,
        "rowDelivery": row_delivery,
        "lanes": {"qq": lane(lanes_in.get("qq")),
                  "desktop": lane(lanes_in.get("desktop"))},
    }


def main():
    notes = []
    messages = []
    health_rows = []
    pipeline = None
    try:
        pipeline = pipeline_signal(notes)
    except Exception as e:
        notes.append(f"链路信号读取失败：{type(e).__name__}")
    for fn, ch in ((qq_rows, "qq"), (desktop_rows, "desktop")):
        try:
            part = fn(notes)
            part.sort(
                key=lambda r: r.get("receivedAtMs") or r.get("fetchedAtMs") or 0,
                reverse=True,
            )
            messages.extend(part[:80])
        except Exception as e:
            notes.append(f"{ch} 通道读取失败：{type(e).__name__}")
    for ch, log in (("qq", f"{QQ_STATE}/relay.log"), ("desktop", f"{DT_STATE}/relay.log")):
        try:
            health_rows.append(health(ch, log))
        except Exception as e:
            notes.append(f"{ch} 健康读取失败：{type(e).__name__}")
    note = trunc("；".join(notes), 500) if notes else None
    print(json.dumps(
        {"messages": messages, "health": health_rows, "readerNote": note,
         "pipeline": pipeline},
        ensure_ascii=False,
    ))


main()
`;

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  readBridgeSnapshot: async () => {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "python3",
        ["-c", READER_PY],
        { timeout: 25_000, maxBuffer: 16 * 1024 * 1024 },
        (err, out) => {
          if (err) reject(err);
          else resolve(out);
        },
      );
    });
    return JSON.parse(stdout) as SnapshotOut;
  },
});
