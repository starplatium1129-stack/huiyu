import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { BoardIcon, type BoardIconName } from "./BoardIcon";
import { bindFlowMotion } from "./pipeline_view.mjs";

type Board = ApiResponse<typeof api, "getBoard">;
type Msg = Board["messages"][number];
type Channel = Msg["channel"];
type Status = Msg["status"];
type Theme = "dark" | "light";
type Tone = "waiting" | "reply" | "sent" | "danger" | "neutral" | "accent";

const REFRESH_MS = 15_000;
const BOARD_KEY = ["board"];
const THEME_KEY = "huiyu-muse-board-theme";
const CHANNELS = { qq: "QQ 群", desktop: "桌面端" } as const;
const STATUS_META: Record<Status, { label: string; tone: Tone }> = {
  queued: { label: "排队中", tone: "waiting" },
  replying: { label: "正在回复", tone: "reply" },
  waiting_send: { label: "等待发送", tone: "reply" },
  delivered: { label: "已送达", tone: "sent" },
  skipped: { label: "选择不回复", tone: "neutral" },
  expired: { label: "已过期", tone: "danger" },
  failed: { label: "发送失败", tone: "danger" },
};
const STATUS_FILTERS = [
  ["all", "全部状态"], ["pending", "等待中"], ["delivered", "已送达"],
  ["uncertain", "送达待核对"], ["skipped", "不回复"], ["expired", "已过期"], ["failed", "失败"],
] as const;
const clock = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const date = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Embedded viewers may block persistent storage.
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function uncertain(m: Msg) {
  return m.deliveryState === "uncertain";
}

function inFlight(m: Msg) {
  return !uncertain(m) && (m.status === "queued" || m.status === "replying" || m.status === "waiting_send");
}

function displayStatus(m: Msg) {
  if (uncertain(m)) return { label: m.deliveryLabel ?? "送达待核对", tone: "waiting" };
  if (m.status === "delivered") return { label: receiptLabel(m.channel), tone: "sent" };
  if (m.status === "waiting_send" && m.firstSentAtMs != null) return { label: "待回执", tone: "waiting" };
  return STATUS_META[m.status];
}

function receiptLabel(channel: Channel) {
  return channel === "qq" ? "QQ 已确认" : "桌面已接收";
}

function fmtClock(ms: number | null) {
  return ms == null ? "—" : clock.format(ms);
}

function fmtStamp(ms: number | null) {
  if (ms == null) return "—";
  return `${date.format(ms)} ${fmtClock(ms)}`;
}

function fmtDur(ms: number | null) {
  if (ms == null) return "—";
  const value = Math.max(0, ms);
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  const seconds = Math.round(value / 1000);
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function attachmentLabel(value: string) {
  if (value === "image/gif") return "动图";
  if (value === "image" || value.startsWith("image/")) return "图片";
  if (value === "audio" || value.startsWith("audio/")) return "语音";
  return value;
}

function displayText(m: Msg) {
  const text = m.text.trim();
  if (text.startsWith("<faceType")) return "表情贴图";
  return text || (m.attachments.length ? "附件消息" : "无文字内容");
}

function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  return <span className="status-pill" data-tone={tone}>{label}</span>;
}

function PipelineNode({ icon, label, tone, active = false }: {
  icon: BoardIconName; label: string; tone: Tone; active?: boolean;
}) {
  return (
    <div className="pipeline-node" data-tone={tone}>
      <div className="node-icon" data-active={active}><BoardIcon name={icon} /></div>
      <span>{label}</span>
    </div>
  );
}

function FlowSegment({ label, count, tone, moving = false, error = false }: {
  label: string; count: number; tone: Tone; moving?: boolean; error?: boolean;
}) {
  return (
    <div className="pipeline-segment" data-tone={error ? "danger" : tone} data-active={count > 0 || error}>
      <div className="flow-track" data-moving={moving && !error} aria-hidden="true">
        <span className="flow-marker" />
      </div>
      <span className="flow-caption">{label}{count > 0 && <b>{count}</b>}</span>
    </div>
  );
}

const ChannelLane = memo(function ChannelLane({ channel, rows, lane, health }: {
  channel: Channel; rows: Msg[];
  lane: NonNullable<Board["pipeline"]>["lanes"][Channel] | undefined;
  health: Board["health"][number] | undefined;
}) {
  const active = rows.filter(inFlight);
  const queued = active.filter((m) => m.status === "queued").length;
  const replying = active.filter((m) => m.status === "replying").length;
  const waiting = active.filter((m) => m.status === "waiting_send" && m.firstSentAtMs == null).length;
  const submitted = active.filter((m) => m.status === "waiting_send" && m.firstSentAtMs != null).length;
  const sent = rows.filter((m) => !uncertain(m) && m.status === "delivered").length;
  const counts = lane?.counts;
  const intake = counts ? counts.awaiting_answer + counts.queued : queued;
  const answering = counts?.answering ?? replying;
  const outbound = counts ? counts.ready + counts.posting + counts.retry + counts.preparing : waiting;
  const audit = counts?.audit ?? submitted;
  const posting = counts?.posting ?? 0;
  const fetchError = Boolean(health?.lastFetchStatus && health.lastFetchStatus !== "ok");
  const intakeError = lane ? lane.intake?.state === "error" : fetchError;
  const state = lane?.node?.state ?? (fetchError ? "offline" : health?.lastFetchStatus === "ok" ? "online" : "unknown");
  const stats = [
    ["排队", intake], ["回复", answering], ["发出", outbound], ["待回执", audit],
  ] as const;

  return (
    <section className="board-panel channel-panel" aria-label={`${CHANNELS[channel]}链路`} data-channel={channel}>
      <div className="panel-heading">
        <h2><BoardIcon name={channel === "qq" ? "chat" : "desktop"} />{CHANNELS[channel]}</h2>
        <StatusPill label={lane?.node?.label ?? (state === "online" ? "已连接" : fetchError ? "连接异常" : "待确认")}
          tone={state === "online" ? "sent" : state === "offline" ? "danger" : "neutral"} />
      </div>
      <div className="pipeline">
        <PipelineNode icon={channel === "qq" ? "chat" : "desktop"} label="来信" tone="neutral" />
        <FlowSegment label={intakeError ? "异常" : "取件"} count={intake} tone="accent" error={intakeError} />
        <PipelineNode icon="gateway" label="网关" tone={intakeError ? "danger" : "accent"} />
        <FlowSegment label="答题" count={answering} tone="reply" moving={answering > 0} />
        <PipelineNode icon="nene" label="宁宁" tone="reply" active={answering > 0} />
        <FlowSegment label="投递" count={outbound + audit} tone="sent" moving={posting > 0} />
        <PipelineNode icon="check" label="送达" tone="sent" />
      </div>
      <dl className="lane-stats">
        {stats.map(([label, value]) => (
          <div key={label} data-nonzero={value > 0}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
        <div data-tone="sent"><dt>{receiptLabel(channel)}</dt><dd>{sent}</dd></div>
      </dl>
      {(intakeError || fetchError || health?.detail) && (
        <details className="lane-detail">
          <summary>{intakeError || fetchError ? "查看取件异常" : "连接详情"}<BoardIcon name="chevron" /></summary>
          <div className="disclosure-body">
            {lane?.intake && <p>{lane.intake.label}</p>}
            {fetchError && <p>{health?.lastFetchStatus}</p>}
            {health?.detail && <p>{health.detail}</p>}
          </div>
        </details>
      )}
    </section>
  );
});

const MessageRow = memo(function MessageRow({ m, now }: { m: Msg; now: number | null }) {
  const status = displayStatus(m);
  const anchor = m.receivedAtMs ?? m.fetchedAtMs;
  const pending = now != null && anchor != null;
  const author = m.kind === "proactive" ? "宁宁主动发言" : m.channel === "qq" ? m.senderName ?? "群友" : "桌面端用户";
  const stages: [string, number | null][] = [
    ["到认领", m.waitMs], ["认领后", m.composeMs], ["发送确认", m.shipMs], ["总计", m.totalMs],
  ];
  const showReason = !uncertain(m) && (m.status === "skipped" || m.status === "expired" || m.status === "failed");

  return (
    <details className="message-row">
      <summary>
        <div className="message-heading">
          <span className="message-author">{author}</span>
          <StatusPill key={status.label} label={status.label} tone={status.tone} />
          {m.kind === "proactive" && m.reviewPending && <StatusPill label="QQ 审核中" tone="waiting" />}
        </div>
        <p className="message-preview">{displayText(m)}</p>
        <div className="message-meta">
          <span>{CHANNELS[m.channel]} · {fmtStamp(anchor)}</span>
          {pending && <span className="duration">已等 {fmtDur(now - anchor)}</span>}
          {!pending && m.totalMs != null && <span className="duration">{fmtDur(m.totalMs)}</span>}
          <BoardIcon name="chevron" />
        </div>
      </summary>
      <div className="message-details disclosure-body">
        <p className="message-full">{displayText(m)}</p>
        {m.attachments.length > 0 && <p className="muted">{m.attachments.map(attachmentLabel).join("、")}</p>}
        {(m.replyText || m.replyAttachments.length > 0) && (
          <div className="message-reply">
            <strong>宁宁</strong>
            {m.replyText && <p className="message-full">{m.replyText}</p>}
            {m.replyAttachments.length > 0 && <p>{m.replyAttachments.map(attachmentLabel).join("、")}</p>}
          </div>
        )}
        {showReason && (
          <p className="message-reason">{m.statusReason ?? "未记录原因"}{m.reasonSource === "inferred" && "（据记录推断）"}</p>
        )}
        <dl className="message-timings">
          {stages.map(([label, value]) => value != null && (
            <div key={label}><dt>{label}</dt><dd>{fmtDur(value)}</dd></div>
          ))}
          {m.firstSentAtMs != null && <div><dt>首次发送</dt><dd>{fmtClock(m.firstSentAtMs)}</dd></div>}
        </dl>
        <p className="message-reference">
          {m.senderRole === "owner" && m.channel === "qq" && "老公 · "}
          {m.senderRole === "member" && m.channel === "qq" && "群友 · "}
          {m.receivedDerived && (m.channel === "desktop" ? "按到件时间 · " : "时间为推导值 · ")}
          #{m.requestKey.slice(0, 8)}
        </p>
      </div>
    </details>
  );
});

const Latency = memo(function Latency({ messages }: { messages: Msg[] }) {
  const done = messages.filter((m): m is Msg & { totalMs: number } =>
    !uncertain(m) && m.status === "delivered" && m.totalMs != null,
  );
  if (done.length === 0) return null;

  const average = (values: (number | null)[]) => {
    const measured = values.filter((value): value is number => value != null);
    return measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null;
  };
  const comparisons = [
    { label: "到认领", value: average(done.map((m) => m.waitMs)), tone: "waiting" },
    { label: "认领后", value: average(done.map((m) => m.composeMs)), tone: "reply" },
    { label: "发送确认", value: average(done.map((m) => m.shipMs)), tone: "sent" },
  ] as const;
  const max = Math.max(1, ...comparisons.map(({ value }) => value ?? 0));
  const buckets = [
    { label: "30 秒内", end: 30_000, count: 0 },
    { label: "30 秒–1 分", end: 60_000, count: 0 },
    { label: "1–3 分", end: 180_000, count: 0 },
    { label: "3 分以上", end: Infinity, count: 0 },
  ];
  for (const { totalMs } of done) {
    const bucket = buckets.find(({ end }) => totalMs < end);
    if (bucket) bucket.count += 1;
  }
  const slowest = done.reduce<Msg & { totalMs: number } | null>(
    (longest, row) => longest == null || row.totalMs > longest.totalMs ? row : longest, null,
  );

  return (
    <section className="board-panel latency-panel" aria-labelledby="latency-heading">
      <div className="panel-heading">
        <h2 id="latency-heading">平均耗时</h2><span className="muted">{done.length} 条已送达</span>
      </div>
      <div className="latency-total">{fmtDur(average(done.map((m) => m.totalMs)))}</div>
      <dl className="latency-comparison">
        {comparisons.map(({ label, value, tone }) => (
          <div key={label} data-tone={tone}>
            <dt>{label}</dt>
            <dd>
              <span className="latency-track" aria-hidden="true">
                <span className="latency-fill" style={{ "--fraction": (value ?? 0) / max } as CSSProperties} />
              </span>
              <span>{fmtDur(value)}</span>
            </dd>
          </div>
        ))}
      </dl>
      <details className="lane-detail">
        <summary>耗时分布<BoardIcon name="chevron" /></summary>
        <div className="disclosure-body latency-notes">
          <dl className="message-timings">
            {buckets.map(({ label, count }) => <div key={label}><dt>{label}</dt><dd>{count} 条</dd></div>)}
          </dl>
          {slowest && <p className="muted">最慢 {CHANNELS[slowest.channel]} · {fmtDur(slowest.totalMs)}</p>}
          <p className="muted">分段按各自有记录的消息计算。一次交回时，认领前可能已经开始写回复。网关取件前和平台内部审核的耗时未计入。</p>
        </div>
      </details>
    </section>
  );
});

export function App() {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(Date.now);
  const [theme, setTheme] = useState(initialTheme);
  const [paused, setPaused] = useState(false);
  const [channel, setChannel] = useState<"all" | Channel>("all");
  const [group, setGroup] = useState("all");
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const [refreshNote, setRefreshNote] = useState<{ text: string; error?: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pauseRef = useRef<HTMLButtonElement>(null);
  const flow = useRef<ReturnType<typeof bindFlowMotion> | null>(null);
  const reading = useRef(false);

  useEffect(() => {
    const root = rootRef.current;
    const button = pauseRef.current;
    if (!root || !button) return;
    const controller = bindFlowMotion(root, button);
    flow.current = controller;
    return () => {
      flow.current = null;
      controller.destroy();
    };
  }, []);

  useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (!pageVisible) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [pageVisible]);

  const board = useQuery({
    queryKey: BOARD_KEY,
    queryFn: () => api.getBoard({ limit: 80 }),
    refetchInterval: pageVisible ? 3000 : false,
  });
  const data = board.data;
  const snapshotAge = data?.refreshedAtMs == null
    ? null
    : Math.max(0, data.serverNow - data.refreshedAtMs) + Math.max(0, now - board.dataUpdatedAt);

  useEffect(() => {
    const sampledAt = data?.pipeline?.sampledAtMs;
    if (board.isError || data == null || sampledAt == null) {
      flow.current?.unavailable();
    } else {
      flow.current?.observed(sampledAt, Math.max(0, data.serverNow - sampledAt));
    }
  }, [board.isError, data]);

  const { mutate: refresh, isPending: refreshing } = useMutation({
    mutationFn: () => api.refreshBoards({}),
    onSuccess: (result, manual: boolean) => {
      if (manual) {
        setRefreshNote(result.started
          ? { text: result.fast ? "已刷新" : "后台读取中" }
          : { text: result.error ? `刷新失败 · ${result.error}` : "刷新失败，请重试", error: true });
      }
      void queryClient.invalidateQueries({ queryKey: BOARD_KEY });
    },
    onError: (error, manual) => {
      if (manual) setRefreshNote({ text: `刷新失败 · ${error.message}`, error: true });
    },
    onSettled: () => { reading.current = false; },
  });

  useEffect(() => {
    if (!pageVisible) return;
    const tick = () => {
      if (document.hidden || reading.current) return;
      reading.current = true;
      refresh(false);
    };
    tick();
    const interval = window.setInterval(tick, REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [pageVisible, refresh]);

  const { messages, qq, desktop, oldestPending } = useMemo(() => {
    const messages = data?.messages ?? [];
    const qq = messages.filter((m) => m.channel === "qq");
    const desktop = messages.filter((m) => m.channel === "desktop");
    const pending = messages.filter(inFlight)
      .sort((a, b) => (a.receivedAtMs ?? a.fetchedAtMs ?? Infinity) - (b.receivedAtMs ?? b.fetchedAtMs ?? Infinity));
    return { messages, qq, desktop, oldestPending: pending[0] };
  }, [data?.messages]);

  const pendingAt = oldestPending?.receivedAtMs ?? oldestPending?.fetchedAtMs;
  const filtered = useMemo(() => {
    const rows = channel === "all" ? messages : channel === "qq" ? qq : desktop;
    if (group === "all") return rows;
    return rows.filter((m) => (uncertain(m) ? "uncertain" : inFlight(m) ? "pending" : m.status) === group);
  }, [channel, desktop, group, messages, qq]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // The selected theme remains active for this view.
    }
  }

  function refreshNow() {
    if (reading.current) return;
    reading.current = true;
    setRefreshNote(null);
    refresh(true);
  }

  return (
    <div ref={rootRef} className="muse-board" data-theme={theme}>
      <main className="board-content">
        <header className="board-header">
          <div className="board-heading">
            <span className="board-mark"><BoardIcon name="nene" /></span>
            <div>
              <h1>消息看板</h1>
              <p>{data?.refreshedAtMs == null ? "等待数据" : `更新于 ${fmtClock(data.refreshedAtMs)}`}</p>
            </div>
          </div>
          <div className="board-actions">
            <button type="button" className="icon-button" aria-label={theme === "dark" ? "切换浅色" : "切换深色"} onClick={toggleTheme}>
              <span key={theme} className="theme-icon"><BoardIcon name={theme === "dark" ? "sun" : "moon"} /></span>
            </button>
            <button type="button" className="icon-button refresh-button" aria-label="刷新看板"
              disabled={refreshing} data-refreshing={refreshing} onClick={refreshNow}>
              <BoardIcon name="refresh" />
            </button>
          </div>
        </header>

        <div className="board-toolbar">
          <div className="board-connection" aria-live="polite">
            {board.isError ? <span data-tone="danger">读取失败</span>
              : !pageVisible ? <span data-tone="neutral">跟随已暂停</span>
              : snapshotAge == null ? <span data-tone="neutral">{board.isPending ? "正在读取" : "等待数据"}</span>
              : snapshotAge >= 2 * REFRESH_MS ? <span data-tone="waiting">数据待刷新</span>
              : <span data-tone="sent">15 秒跟随</span>}
            {refreshNote && <span data-tone={refreshNote.error ? "danger" : "neutral"}>{refreshNote.text}</span>}
          </div>
          <button type="button" ref={pauseRef} className="icon-button flow-toggle"
            aria-label="暂停链路动效" onClick={() => setPaused((value) => !value)}>
            <BoardIcon name={paused ? "play" : "pause"} />
          </button>
        </div>

        <div className="board-lanes">
          <ChannelLane channel="qq" rows={qq} lane={data?.pipeline?.lanes.qq} health={data?.health.find((item) => item.channel === "qq")} />
          <ChannelLane channel="desktop" rows={desktop} lane={data?.pipeline?.lanes.desktop} health={data?.health.find((item) => item.channel === "desktop")} />
        </div>

        {oldestPending && pendingAt != null && (
          <div className="pending-callout" data-tone="waiting">
            <BoardIcon name="warning" /><span>{CHANNELS[oldestPending.channel]}最早一条</span>
            <strong>已等 {fmtDur(now - pendingAt)}</strong>
          </div>
        )}

        <Latency messages={messages} />

        <section className="board-panel messages-panel" aria-labelledby="messages-heading">
          <div className="panel-heading">
            <h2 id="messages-heading">最近消息</h2>
            <label className="status-filter">
              <span className="sr-only">按状态筛选</span>
              <select value={group} onChange={(event) => setGroup(event.target.value)}>
                {STATUS_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <BoardIcon name="chevron" />
            </label>
          </div>
          <div className="channel-filter" role="group" aria-label="按渠道筛选"
            style={{ "--selection": channel === "all" ? 0 : channel === "qq" ? 1 : 2 } as CSSProperties}>
            {([["all", "全部"], ["qq", "QQ 群"], ["desktop", "桌面端"]] as const).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={channel === value} onClick={() => setChannel(value)}>{label}</button>
            ))}
          </div>
          {filtered.length === 0 && (
            <p className="board-empty">{board.isPending ? "正在读取…" : board.isError ? "读取失败，点刷新重试。" : "暂无消息"}</p>
          )}
          <div className="message-list">
            {filtered.map((m) => <MessageRow key={m.id} m={m} now={inFlight(m) ? now : null} />)}
          </div>
        </section>

        {data?.readerNote && (
          <details className="reader-note lane-detail">
            <summary>读取备注<BoardIcon name="chevron" /></summary>
            <p className="disclosure-body">{data.readerNote}</p>
          </details>
        )}
      </main>
    </div>
  );
}
