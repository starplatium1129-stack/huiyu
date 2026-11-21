import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
// Codex's pipeline_view module (vendored verbatim from
// ~/workspace/bridge-tools/page-assets/pipeline_view.mjs): it owns
// the chain diagram's signal badge text, segment captions, moving
// flags, and the freshness/motion gating on the page root.
import {
  bindFlowMotion,
  paintSignal,
  paintTraffic,
} from "./pipeline_view.mjs";

type Board = ApiResponse<typeof api, "getBoard">;
type Msg = Board["messages"][number];
type Status = Msg["status"];
type Channel = Msg["channel"];

const STATUS_META: Record<
  Status,
  { label: string; color: string; group: string }
> = {
  queued: { label: "排队中", color: "var(--st-wait)", group: "pending" },
  replying: { label: "正在回复", color: "var(--st-reply)", group: "pending" },
  waiting_send: { label: "等待发送", color: "var(--st-reply)", group: "pending" },
  delivered: { label: "已送达", color: "var(--st-sent)", group: "delivered" },
  skipped: { label: "选择不回复", color: "var(--st-bad)", group: "skipped" },
  expired: { label: "已过期", color: "var(--st-bad)", group: "expired" },
  failed: { label: "发送失败", color: "var(--st-bad)", group: "failed" },
};

const PENDING: Status[] = ["queued", "replying", "waiting_send"];

// A row whose delivery verdict is "uncertain" （送达待核对） is
// terminal in the delivery engine — it will not be sent again —
// even though its bridge status still reads waiting_send (or, for
// the parent reply row, expired-after-fallback). Such rows render
// as settled: the delivery label as the status text, a muted
// terminal style, and no place in any in-flight count, the stuck
// callout, or the chain diagram's in-transit numbers.
function isUncertain(m: Msg): boolean {
  return m.deliveryState === "uncertain";
}

function inFlight(m: Msg): boolean {
  return !isUncertain(m) && PENDING.includes(m.status);
}

// Filter-group for a row: uncertain rows group with the other
// terminal outcomes instead of "pending".
function rowGroup(m: Msg): string {
  return isUncertain(m) ? "expired" : STATUS_META[m.status].group;
}

function fmtClock(ms: number | null): string {
  if (ms == null) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function fmtDay(ms: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return "今天";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(d);
}

function fmtDur(ms: number | null): string {
  if (ms == null) return "—";
  const s = ms / 1000;
  if (s < 1) return `${Math.round(ms)}ms`;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return rest > 0 ? `${m}m${rest}s` : `${m}m`;
}

function fmtAgo(ms: number | null, now: number): string {
  if (ms == null) return "尚未刷新";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 5) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.floor(m / 60)} 小时前`;
}

function attLabel(att: string): string {
  if (att === "image" || att.startsWith("image/")) return "图片";
  if (att === "audio" || att.startsWith("audio/")) return "语音";
  if (att === "image/gif") return "动图";
  return att;
}

function displayText(m: Msg): string {
  const t = m.text.trim();
  if (t) {
    if (t.startsWith("<faceType")) return "［表情贴图］";
    return t;
  }
  if (m.attachments.length > 0) return "［附件消息］";
  return "［无文字内容］";
}

function Lamp({ color, live }: { color: string; live?: boolean }) {
  return (
    <span
      aria-hidden
      className={live ? "lamp-live" : undefined}
      style={{
        display: "inline-block",
        width: 9,
        height: 9,
        borderRadius: 999,
        background: color,
        boxShadow: `0 0 8px ${color}`,
        flexShrink: 0,
      }}
    />
  );
}

function Seg({ label, value }: { label: string; value: string }) {
  return (
    <span className="whitespace-nowrap">
      <span style={{ color: "var(--dim)" }}>{label} </span>
      <span className="font-mono" style={{ color: "var(--text)" }}>
        {value}
      </span>
    </span>
  );
}

type FlowState = "idle" | "active-in" | "active-out" | "error";

function FlowSegment({
  state,
  color,
  label,
  count,
  moving,
}: {
  state: FlowState;
  color: string;
  label: string;
  count?: number;
  moving?: boolean;
}) {
  const active = state === "active-in" || state === "active-out";
  const trackRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLParagraphElement>(null);
  // paintTraffic owns the caption text ("label · N 条") and the
  // track's data-muse-moving flag; the marker dot inside the track
  // is painted by the vendored pipeline_view CSS whenever the page
  // root's motion gate is on and the segment is moving.
  useEffect(() => {
    const track = trackRef.current;
    const caption = captionRef.current;
    if (track && caption) {
      paintTraffic(track, caption, { label, count, moving });
    }
  }, [label, count, moving]);
  return (
    <div className="flex-1 min-w-5 px-0.5">
      <div
        ref={trackRef}
        data-muse-flow
        className="flex items-center"
        style={{ height: 40, color }}
        aria-hidden
      >
        <div
          className="flow-track w-full"
          data-state={state}
          style={{ "--flow-color": color } as CSSProperties}
        />
        <span
          style={{
            width: 0,
            height: 0,
            borderTop: "4px solid transparent",
            borderBottom: "4px solid transparent",
            borderLeft: `6px solid ${active ? color : "var(--border)"}`,
            flexShrink: 0,
          }}
        />
        <span data-muse-marker aria-hidden />
      </div>
      <p
        ref={captionRef}
        className="text-center whitespace-nowrap"
        style={{
          fontSize: 10,
          lineHeight: "14px",
          color: state === "error" ? "var(--st-bad)" : active ? color : "var(--dim)",
        }}
      />
    </div>
  );
}

function PipelineNode({
  glyph,
  label,
  sub,
  color,
  live,
  signal,
}: {
  glyph: string;
  label: string;
  sub: string;
  color: string;
  live?: boolean;
  signal?: { state: string; label: string; color: string };
}) {
  const badgeRef = useRef<HTMLSpanElement>(null);
  // paintSignal owns the badge's text and its data-muse-state; the
  // ● stays a separate decorative span so the paint never wipes it.
  useEffect(() => {
    if (badgeRef.current && signal) paintSignal(badgeRef.current, signal);
  }, [signal]);
  return (
    <div className="flex flex-col items-center shrink-0" style={{ width: 50 }}>
      <div
        className={live ? "node-live" : undefined}
        style={{
          width: 40,
          height: 40,
          borderRadius: 999,
          border: `1.5px solid ${color}`,
          background: "var(--surface-2)",
          color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: glyph.length > 2 ? 11 : 13,
          fontWeight: 700,
          letterSpacing: glyph.length > 2 ? 0 : 1,
        }}
      >
        {glyph}
      </div>
      <p
        className="mt-1 text-center font-medium"
        style={{ fontSize: 11, lineHeight: "14px", color: "var(--text)" }}
      >
        {label}
      </p>
      <p
        className="text-center"
        style={{ fontSize: 11, lineHeight: "14px", color: "var(--dim)" }}
      >
        {sub}
      </p>
      {signal && (
        <p
          className="text-center whitespace-nowrap"
          style={{ fontSize: 10, lineHeight: "13px", color: signal.color }}
        >
          <span aria-hidden>● </span>
          <span ref={badgeRef} />
        </p>
      )}
    </div>
  );
}

function MessageRow({
  m,
  now,
  expanded,
  onToggle,
}: {
  m: Msg;
  now: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = STATUS_META[m.status];
  const uncertain = isUncertain(m);
  const isPending = inFlight(m);
  const anchor = m.receivedAtMs ?? m.fetchedAtMs;
  const waitingFor = isPending && anchor != null ? now - anchor : null;
  const longText = m.text.length > 90 || (m.replyText ?? "").length > 90;
  // Receipt wording settled with Codex: a submitted-but-unconfirmed send
  // reads 「已提交请求，等待回执」; a confirmed one names the platform.
  // An uncertain delivery overrides both with its own verdict label
  // （送达待核对）: the send is finished, only the receipt is unknown.
  const statusLabel = uncertain
    ? (m.deliveryLabel ?? "送达待核对")
    : m.status === "delivered"
      ? m.channel === "qq"
        ? "QQ 已确认"
        : "桌面已接收"
      : meta.label;
  const statusColor = uncertain ? "var(--dim)" : meta.color;
  const submitted =
    !uncertain && m.status === "waiting_send" && m.firstSentAtMs != null;

  return (
    <article
      className="py-3"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <div className="flex items-start gap-2.5">
        <span className="pt-1.5">
          <Lamp color={statusColor} live={isPending} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              className="text-sm font-semibold"
              style={{ color: statusColor }}
            >
              {statusLabel}
            </span>
            {m.kind === "proactive" && m.reviewPending && (
              <span
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ background: "var(--surface-2)", color: "var(--st-wait)" }}
              >
                QQ 审核中
              </span>
            )}
            {m.kind === "proactive" ? (
              <span className="text-sm font-medium" style={{ color: "var(--text)" }}>
                宁宁主动发言
              </span>
            ) : (
              <span className="text-sm font-medium" style={{ color: "var(--text)" }}>
                {m.channel === "qq" ? (m.senderName ?? "?") : "桌面端用户"}
              </span>
            )}
            {m.channel === "qq" && m.senderRole === "owner" && (
              <span
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ background: "var(--surface-2)", color: "var(--st-wait)" }}
              >
                老公
              </span>
            )}
            {m.channel === "qq" && m.senderRole === "member" && (
              <span
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ background: "var(--surface-2)", color: "var(--dim)" }}
              >
                群友
              </span>
            )}
            <span className="text-xs font-mono ml-auto" style={{ color: "var(--dim)" }}>
              {fmtDay(anchor)} {fmtClock(anchor)}
              {m.receivedDerived && m.channel === "desktop" ? " ·到件时间" : ""}
              {m.receivedDerived && m.channel === "qq" ? " ·时间推导" : ""}
            </span>
          </div>

          <p
            className="mt-1 text-sm break-words"
            style={{
              color: "var(--text)",
              display: expanded ? undefined : "-webkit-box",
              WebkitLineClamp: expanded ? undefined : 2,
              WebkitBoxOrient: "vertical",
              overflow: expanded ? undefined : "hidden",
            }}
          >
            {displayText(m)}
            {m.attachments.length > 0 && (
              <span style={{ color: "var(--dim)" }}>
                {" "}
                [{m.attachments.map(attLabel).join("、")}]
              </span>
            )}
          </p>

          {m.replyText != null && m.replyText !== "" && (
            <p
              className="mt-1.5 text-sm break-words pl-3"
              style={{
                borderLeft: "2px solid var(--st-sent)",
                color: "var(--dim)",
                display: expanded ? undefined : "-webkit-box",
                WebkitLineClamp: expanded ? undefined : 2,
                WebkitBoxOrient: "vertical",
                overflow: expanded ? undefined : "hidden",
              }}
            >
              <span style={{ color: "var(--st-sent)" }}>宁宁：</span>
              {m.replyText}
              {m.replyAttachments.length > 0 && (
                <span> [{m.replyAttachments.map(attLabel).join("、")}]</span>
              )}
            </p>
          )}

          {submitted && (
            <p className="mt-1 text-xs" style={{ color: "var(--st-reply)" }}>
              已提交请求，等待回执
              {m.firstSentAtMs != null && (
                <span className="font-mono" style={{ color: "var(--dim)" }}>
                  {" "}
                  · 首次发送 {fmtClock(m.firstSentAtMs)}
                </span>
              )}
            </p>
          )}

          {!uncertain &&
            (m.status === "skipped" || m.status === "expired" || m.status === "failed") && (
            <p className="mt-1 text-xs" style={{ color: "var(--st-bad)" }}>
              原因：
              {m.statusReason ??
                (m.reasonSource === "unknown" || m.reasonSource == null
                  ? "未记录"
                  : "—")}
              {m.reasonSource === "inferred" && (
                <span style={{ color: "var(--dim)" }}>（据记录推断）</span>
              )}
              {m.reasonSource === "recorded" && (
                <span style={{ color: "var(--dim)" }}>（有记录）</span>
              )}
            </p>
          )}

          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            {isPending && waitingFor != null && (
              <Seg label="已等待" value={fmtDur(waitingFor)} />
            )}
            {m.waitMs != null && <Seg label="等接单" value={fmtDur(m.waitMs)} />}
            {m.composeMs != null && <Seg label="写回复" value={fmtDur(m.composeMs)} />}
            {m.firstSentAtMs != null && (
              <Seg label="首次发送" value={fmtClock(m.firstSentAtMs)} />
            )}
            {m.shipMs != null && <Seg label="发送" value={fmtDur(m.shipMs)} />}
            {m.totalMs != null && <Seg label="总计" value={fmtDur(m.totalMs)} />}
            <span className="font-mono" style={{ color: "var(--dim)" }}>
              #{m.requestKey.slice(0, 8)}
            </span>
            {longText && (
              <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                className="text-xs underline underline-offset-2"
                style={{ color: "var(--accent)", minHeight: 24 }}
              >
                {expanded ? "收起" : "展开全文"}
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const [channelFilter, setChannelFilter] = useState<"all" | Channel>("all");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [pageVisible, setPageVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const pauseBtnRef = useRef<HTMLButtonElement>(null);
  const flowCtlRef = useRef<ReturnType<typeof bindFlowMotion> | null>(null);

  // The vendored pipeline_view module gates the chain diagram's
  // motion on snapshot freshness (max age 12s, its default), the
  // pause button, and page visibility. It sets data-muse-motion /
  // data-muse-fresh on the page root; its CSS does the rest.
  useEffect(() => {
    const root = rootRef.current;
    const btn = pauseBtnRef.current;
    if (!root || !btn) return;
    const ctl = bindFlowMotion(root, btn);
    flowCtlRef.current = ctl;
    return () => {
      ctl.destroy();
      flowCtlRef.current = null;
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Flow animations pause while the page is in the background
  // (Codex's page-side module rule; reduced-motion is handled in CSS).
  useEffect(() => {
    const onVis = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const board = useQuery({
    queryKey: ["board"],
    queryFn: () => api.getBoard({ limit: 80 }),
    refetchInterval: 3000,
  });

  // Feed the flow-motion gate: every successful snapshot read
  // reports its sample time and its age (calibrated with the
  // server's own clock); a failed read marks the data unavailable.
  useEffect(() => {
    const ctl = flowCtlRef.current;
    if (!ctl) return;
    if (board.isError) {
      ctl.unavailable();
      return;
    }
    const d = board.data;
    if (!d) return;
    const sampledAt = d.pipeline?.sampledAtMs ?? null;
    if (sampledAt == null) {
      ctl.unavailable();
      return;
    }
    ctl.observed(sampledAt, Math.max(0, d.serverNow - sampledAt));
  }, [board.data, board.isError]);

  const refresh = useMutation({
    mutationFn: async () => await api.refreshBoards({}),
    onSuccess: (r) => {
      setRefreshNote(
        r.started
          ? r.fast
            ? `已重新读取两桥记录（${r.saved} 条），刚刚更新`
            : "正在重新读取两桥记录，十几秒内更新…"
          : `刷新没能启动：${r.error ?? "未知错误"}`,
      );
      void queryClient.invalidateQueries({ queryKey: ["board"] });
    },
    onError: (e) => {
      setRefreshNote(`刷新失败：${e instanceof Error ? e.message : String(e)}`);
    },
  });

  // Real-time following: while the board is open and visible, re-read
  // the bridges' records every 15 seconds. The server-side read is a
  // fast deterministic pass (<1s), so this stays cheap; the 3s
  // getBoard poll above only re-reads the local snapshot. Pauses
  // automatically when the page is hidden (the interval is torn down
  // and an immediate refresh fires when the page comes back).
  useEffect(() => {
    if (!pageVisible) return;
    let cancelled = false;
    const tick = async () => {
      try {
        await api.refreshBoards({});
        if (!cancelled) {
          void queryClient.invalidateQueries({ queryKey: ["board"] });
        }
      } catch {
        // Silent: the manual refresh button surfaces errors; the
        // "数据更新于" line shows staleness honestly meanwhile.
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [pageVisible, queryClient]);

  const data = board.data;
  const messages = useMemo(() => data?.messages ?? [], [data]);

  const stats = useMemo(() => {
    const per = (ch: Channel) => {
      const rows = messages.filter((m) => m.channel === ch);
      return {
        pending: rows.filter((m) => inFlight(m)).length,
        delivered: rows.filter((m) => m.status === "delivered").length,
        skipped: rows.filter((m) => m.status === "skipped").length,
        expired: rows.filter((m) => m.status === "expired").length,
      };
    };
    return { qq: per("qq"), desktop: per("desktop") };
  }, [messages]);

  const oldestPending = useMemo(() => {
    const pending = messages
      .filter((m) => inFlight(m))
      .map((m) => ({ m, anchor: m.receivedAtMs ?? m.fetchedAtMs ?? 0 }))
      .sort((a, b) => a.anchor - b.anchor);
    return pending[0]?.m ?? null;
  }, [messages]);

  const latency = useMemo(() => {
    const done = messages.filter(
      (m) => m.status === "delivered" && m.totalMs != null,
    );
    if (done.length === 0) return null;
    const avg = (pick: (m: Msg) => number | null) => {
      const vals = done
        .map(pick)
        .filter((v): v is number => v != null);
      if (vals.length === 0) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const buckets = [
      { label: "<30s", n: 0 },
      { label: "30s–1m", n: 0 },
      { label: "1–3m", n: 0 },
      { label: ">3m", n: 0 },
    ];
    for (const m of done) {
      const t = m.totalMs ?? 0;
      const b =
        t < 30_000 ? buckets[0] : t < 60_000 ? buckets[1] : t < 180_000 ? buckets[2] : buckets[3];
      if (b) b.n += 1;
    }
    const slowest = [...done].sort((a, b) => (b.totalMs ?? 0) - (a.totalMs ?? 0))[0] ?? null;
    return {
      count: done.length,
      avgTotal: avg((m) => m.totalMs),
      avgWait: avg((m) => m.waitMs),
      avgCompose: avg((m) => m.composeMs),
      avgShip: avg((m) => m.shipMs),
      buckets,
      maxBucket: Math.max(1, ...buckets.map((b) => b.n)),
      slowest,
    };
  }, [messages]);

  const filtered = useMemo(() => {
    return messages.filter((m) => {
      if (channelFilter !== "all" && m.channel !== channelFilter) return false;
      if (groupFilter !== "all" && rowGroup(m) !== groupFilter)
        return false;
      return true;
    });
  }, [messages, channelFilter, groupFilter]);

  const healthOf = (ch: Channel) => data?.health.find((h) => h.channel === ch);
  const healthLamp = (ch: Channel): string => {
    const h = healthOf(ch);
    if (!h?.lastFetchStatus) return "var(--dim)";
    return h.lastFetchStatus === "ok" ? "var(--st-sent)" : "var(--st-bad)";
  };

  const toggle = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const channelLane = (
    ch: Channel,
    title: string,
    peerGlyph: string,
    peerLabel: string,
    gwSub: string,
  ) => {
    const s = stats[ch];
    const h = healthOf(ch);
    const rows = messages.filter((m) => m.channel === ch);
    // Uncertain-delivery rows are settled (see isUncertain): they
    // never count toward any in-flight stage below.
    const nQueued = rows.filter(
      (m) => !isUncertain(m) && m.status === "queued",
    ).length;
    const nReplying = rows.filter(
      (m) => !isUncertain(m) && m.status === "replying",
    ).length;
    // Five-stage pipeline counts (Codex's signal model): a waiting_send
    // row with a first-send attempt on record is already submitted and
    // only awaiting the platform receipt — a different stage from a
    // reply that has not been sent yet.
    const nWaiting = rows.filter(
      (m) =>
        !isUncertain(m) &&
        m.status === "waiting_send" &&
        m.firstSentAtMs == null,
    ).length;
    const nSubmitted = rows.filter(
      (m) =>
        !isUncertain(m) &&
        m.status === "waiting_send" &&
        m.firstSentAtMs != null,
    ).length;
    const fetchError = !!h?.lastFetchStatus && h.lastFetchStatus !== "ok";
    // Chain-diagram signals come from the collectors' board-status
    // snapshot (lanes): per-stage counts drive the three segments,
    // the gateway node carries the connector probe's own verdict.
    // When no lane snapshot has been stored yet, fall back to the
    // counts derived from the stored message rows, as before.
    const lane = data?.pipeline?.lanes[ch] ?? null;
    const lc = lane?.counts ?? null;
    const inCount = lc ? lc.awaiting_answer + lc.queued : nQueued;
    const midCount = lc ? lc.answering : nReplying;
    const outWait = lc ? lc.ready + lc.posting + lc.retry + lc.preparing : nWaiting;
    // `uncertain` （送达待核对） is terminal in the delivery engine:
    // it is NOT part of the out segment's in-transit count, exactly
    // as it is already excluded from `moving` below.
    const outSubmitted = lc ? lc.audit : nSubmitted;
    const outCount = outWait + outSubmitted;
    const intakeError = lc ? lane?.intake?.state === "error" : fetchError;
    const inState: FlowState = intakeError
      ? "error"
      : inCount > 0
        ? "active-in"
        : "idle";
    const midState: FlowState = midCount > 0 ? "active-in" : "idle";
    const outState: FlowState = outCount > 0 ? "active-out" : "idle";
    // moving = work the collector confirms at that stage. On the out
    // segment, `uncertain` （送达待核对） is deliberately not moving:
    // no transfer is known to be in progress for it.
    const inMoving = inCount > 0;
    const midMoving = midCount > 0;
    const outMoving = lc
      ? lc.ready + lc.posting + lc.retry + lc.preparing + lc.audit > 0
      : outCount > 0;
    const transferring = s.pending > 0;
    const gwSignal = lane?.node
      ? {
          state: lane.node.state,
          label: lane.node.label,
          color:
            lane.node.state === "online"
              ? "var(--st-sent)"
              : lane.node.state === "offline"
                ? "var(--st-bad)"
                : "var(--dim)",
        }
      : fetchError
        ? { state: "error", label: "连接异常", color: "var(--st-bad)" }
        : h?.lastFetchStatus === "ok"
          ? { state: "online", label: "连接器在线", color: "var(--st-sent)" }
          : { state: "unknown", label: "信号未知", color: "var(--dim)" };
    return (
      <section
        className="p-3.5"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
        }}
        aria-label={`${title}链路`}
      >
        <div className="flex items-center gap-2">
          <Lamp color={healthLamp(ch)} live={transferring} />
          <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
            {title}
          </h2>
          <span
            className="text-xs font-medium"
            style={{ color: transferring ? "var(--st-reply)" : "var(--dim)" }}
            role="status"
          >
            {transferring ? `传输中 · ${s.pending} 条在路上` : "链路空闲"}
          </span>
          <span className="ml-auto text-xs font-mono" style={{ color: "var(--dim)" }}>
            {h?.lastFetchStatus
              ? h.lastFetchStatus === "ok"
                ? "桥轮询正常"
                : `取件异常 ${h.lastFetchStatus}`
              : "暂无轮询记录"}
          </span>
        </div>

        {/* Gateway pipeline: peer ⇄ gateway ⇄ bridge ⇄ Nene ⇄ out.
            Each segment lights up and flows only while a message is
            actually in that stage. */}
        <div className="mt-3 flex items-start">
          <PipelineNode
            glyph={peerGlyph}
            label={peerLabel}
            sub="消息来源"
            color="var(--dim)"
          />
          <FlowSegment
            state={inState}
            color="var(--accent)"
            label={intakeError ? "异常" : "取件"}
            count={inCount}
            moving={inMoving}
          />
          <PipelineNode
            glyph="网关"
            label="绘遇网关"
            sub={gwSub}
            color={fetchError ? "var(--st-bad)" : "var(--accent)"}
            live={inCount > 0}
            signal={gwSignal}
          />
          <FlowSegment
            state={midState}
            color="var(--st-reply)"
            label="答题"
            count={midCount}
            moving={midMoving}
          />
          <PipelineNode
            glyph="宁宁"
            label="宁宁"
            sub={nReplying > 0 ? "正在回复" : "待命"}
            color="var(--st-reply)"
            live={nReplying > 0}
          />
          <FlowSegment
            state={outState}
            color="var(--st-sent)"
            label={outWait === 0 && outSubmitted > 0 ? "待回执" : "发送"}
            count={outCount}
            moving={outMoving}
          />
          <PipelineNode
            glyph="送达"
            label={peerLabel}
            sub={`${ch === "qq" ? "QQ 已确认" : "桌面已接收"} ${s.delivered}`}
            color="var(--st-sent)"
          />
        </div>

        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <span style={{ color: nQueued > 0 ? "var(--st-wait)" : "var(--dim)" }}>
            排队 <b className="font-mono">{nQueued}</b>
          </span>
          <span style={{ color: nReplying > 0 ? "var(--st-reply)" : "var(--dim)" }}>
            正在回复 <b className="font-mono">{nReplying}</b>
          </span>
          <span style={{ color: nWaiting > 0 ? "var(--st-reply)" : "var(--dim)" }}>
            等待发送 <b className="font-mono">{nWaiting}</b>
          </span>
          <span style={{ color: nSubmitted > 0 ? "var(--st-wait)" : "var(--dim)" }}>
            已提交·待回执 <b className="font-mono">{nSubmitted}</b>
          </span>
          <span style={{ color: "var(--st-sent)" }}>
            {ch === "qq" ? "QQ 已确认" : "桌面已接收"}{" "}
            <b className="font-mono">{s.delivered}</b>
          </span>
          <span style={{ color: s.skipped > 0 ? "var(--st-bad)" : "var(--dim)" }}>
            不回复 <b className="font-mono">{s.skipped}</b>
          </span>
          <span style={{ color: s.expired > 0 ? "var(--st-bad)" : "var(--dim)" }}>
            已过期 <b className="font-mono">{s.expired}</b>
          </span>
        </div>
        {h?.detail && (
          <p className="mt-1.5 text-xs" style={{ color: "var(--dim)" }}>
            {h.detail}
          </p>
        )}
      </section>
    );
  };

  return (
    <div
      ref={rootRef}
      className={`min-h-screen${pageVisible ? "" : " board-paused"}`}
      style={{ background: "var(--bg)" }}
    >
      <main className="mx-auto max-w-3xl px-4 pb-10 pt-4">
        {/* Gateway pipeline lanes */}
        <div className="grid grid-cols-1 gap-3">
          {channelLane("qq", "QQ 群", "QQ", "QQ 群", "主力机")}
          {channelLane("desktop", "桌面端", "桌面", "桌面端", "主力机")}
        </div>

        {/* Stuck callout */}
        {oldestPending && (
          <div
            className="mt-3 px-3.5 py-2.5 flex items-center gap-2.5"
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--st-wait)",
              borderRadius: "var(--radius)",
            }}
            role="status"
          >
            <Lamp color="var(--st-wait)" live />
            <p className="text-sm" style={{ color: "var(--text)" }}>
              最早一条还在等：
              <b>
                {oldestPending.channel === "qq"
                  ? (oldestPending.senderName ?? "?")
                  : "桌面端"}
              </b>
              「{displayText(oldestPending).slice(0, 24)}」已等待{" "}
              <b className="font-mono" style={{ color: "var(--st-wait)" }}>
                {fmtDur(
                  now -
                    (oldestPending.receivedAtMs ?? oldestPending.fetchedAtMs ?? now),
                )}
              </b>
              ，状态 {STATUS_META[oldestPending.status].label}
            </p>
          </div>
        )}

        {/* Refresh row */}
        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            aria-label="立即刷新看板"
            className="px-4 py-2 text-sm font-medium rounded-lg"
            style={{
              background: "var(--accent)",
              color: "#0b1220",
              opacity: refresh.isPending ? 0.6 : 1,
            }}
          >
            {refresh.isPending ? "刷新中…" : "立即刷新"}
          </button>
          <button
            type="button"
            ref={pauseBtnRef}
            aria-label="暂停链路动效"
            className="px-3 py-2 text-sm rounded-lg"
            style={{
              background: "var(--surface)",
              color: "var(--text)",
              border: "1px solid var(--border)",
            }}
          >
            暂停链路动效
          </button>
          <span
            data-muse-stale
            className="text-xs font-medium"
            style={{ color: "var(--st-wait)" }}
          >
            数据待刷新
          </span>
          <span
            className="inline-flex items-center gap-1.5 text-xs"
            style={{ color: "var(--dim)" }}
            role="status"
          >
            <Lamp color={pageVisible ? "var(--st-sent)" : "var(--dim)"} live={pageVisible} />
            {pageVisible ? "实时跟随中 · 每 15 秒自动重读" : "页面在后台，跟随已暂停"}
          </span>
          <span className="text-xs" style={{ color: "var(--dim)" }}>
            数据更新于 {fmtAgo(data?.refreshedAtMs ?? null, now)}
            {data?.refreshedAtMs != null && (
              <span className="font-mono"> · {fmtClock(data.refreshedAtMs)}</span>
            )}
          </span>
          {refreshNote && (
            <span className="text-xs" style={{ color: "var(--st-reply)" }}>
              {refreshNote}
            </span>
          )}
        </div>
        {data?.readerNote && (
          <p className="mt-1.5 text-xs" style={{ color: "var(--dim)" }}>
            读取备注：{data.readerNote}
          </p>
        )}
        <p className="mt-1.5 text-xs" style={{ color: "var(--dim)" }}>
          看板读的是两座桥在本地留下的记录；消息还在网关、没被桥取走的那一段，以及平台审核的内部原因，本地记录里没有，这里不会猜。分段耗时里「等接单」是消息到达后等工人认领的时间，「写回复」是认领后写出回复的时间——排队堵住会算在等接单里，不会混进写回复。
        </p>

        {/* Filters */}
        <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="筛选">
          {(
            [
              ["all", "全部渠道"],
              ["qq", "QQ 群"],
              ["desktop", "桌面端"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={channelFilter === v}
              onClick={() => setChannelFilter(v)}
              className="px-3 py-1.5 text-sm rounded-full"
              style={{
                background:
                  channelFilter === v ? "var(--accent)" : "var(--surface)",
                color: channelFilter === v ? "#0b1220" : "var(--text)",
                border: "1px solid var(--border)",
              }}
            >
              {label}
            </button>
          ))}
          <span className="w-2" />
          {(
            [
              ["all", "全部状态"],
              ["pending", "等待中"],
              ["delivered", "已送达"],
              ["skipped", "不回复"],
              ["expired", "已过期"],
              ["failed", "失败"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={groupFilter === v}
              onClick={() => setGroupFilter(v)}
              className="px-3 py-1.5 text-sm rounded-full"
              style={{
                background:
                  groupFilter === v ? "var(--surface-2)" : "var(--surface)",
                color: "var(--text)",
                border:
                  groupFilter === v
                    ? "1px solid var(--accent)"
                    : "1px solid var(--border)",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Message list */}
        <section aria-label="消息列表" className="mt-2">
          {board.isPending && (
            <p className="py-10 text-center text-sm" style={{ color: "var(--dim)" }}>
              正在读取看板…
            </p>
          )}
          {board.isError && (
            <p className="py-10 text-center text-sm" style={{ color: "var(--st-bad)" }}>
              看板读取失败，稍后再试。
            </p>
          )}
          {data && messages.length === 0 && (
            <div className="py-10 text-center">
              <p className="text-sm" style={{ color: "var(--dim)" }}>
                还没有记录到消息。点「立即刷新」读取两桥的最新记录。
              </p>
            </div>
          )}
          {data && messages.length > 0 && filtered.length === 0 && (
            <p className="py-10 text-center text-sm" style={{ color: "var(--dim)" }}>
              当前筛选下没有消息。
            </p>
          )}
          {filtered.map((m) => (
            <MessageRow
              key={m.id}
              m={m}
              now={now}
              expanded={expanded.has(m.id)}
              onToggle={() => toggle(m.id)}
            />
          ))}
        </section>

        {/* Latency */}
        {latency && (
          <section
            className="mt-6 p-3.5"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
            }}
            aria-label="耗时分析"
          >
            <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
              耗时分析
              <span className="ml-2 text-xs font-normal" style={{ color: "var(--dim)" }}>
                已送达 {latency.count} 条的平均分段
              </span>
            </h2>
            <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <Seg label="平均总计" value={fmtDur(latency.avgTotal)} />
              <Seg label="等接单" value={fmtDur(latency.avgWait)} />
              <Seg label="写回复" value={fmtDur(latency.avgCompose)} />
              <Seg label="发送确认" value={fmtDur(latency.avgShip)} />
            </div>
            <div className="mt-3 space-y-1.5">
              {latency.buckets.map((b) => (
                <div key={b.label} className="flex items-center gap-2 text-xs">
                  <span
                    className="font-mono w-16 shrink-0"
                    style={{ color: "var(--dim)" }}
                  >
                    {b.label}
                  </span>
                  <div
                    className="h-2.5 rounded"
                    style={{
                      width: `${Math.max(2, (b.n / latency.maxBucket) * 100)}%`,
                      maxWidth: 260,
                      background:
                        b.label === ">3m" ? "var(--st-bad)" : "var(--st-reply)",
                    }}
                  />
                  <span className="font-mono" style={{ color: "var(--text)" }}>
                    {b.n}
                  </span>
                </div>
              ))}
            </div>
            {latency.slowest && (
              <p className="mt-3 text-xs" style={{ color: "var(--dim)" }}>
                最慢一条：{latency.slowest.channel === "qq" ? "QQ 群" : "桌面端"}{" "}
                {latency.slowest.senderName ?? ""}「
                {displayText(latency.slowest).slice(0, 20)}」总计{" "}
                <span className="font-mono" style={{ color: "var(--st-wait)" }}>
                  {fmtDur(latency.slowest.totalMs)}
                </span>
                ，其中写回复{" "}
                <span className="font-mono">{fmtDur(latency.slowest.composeMs)}</span>
              </p>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
