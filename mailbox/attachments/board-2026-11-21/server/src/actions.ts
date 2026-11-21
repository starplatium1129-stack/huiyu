// Actions for the QQ + desktop message board.
//
// Data flow (single retrieval path):
//   refreshBoards  — reads the two bridges' local records on this
//                    machine and saves a fresh snapshot. Fast path:
//                    a privileged host handler (server/src/privileged.ts)
//                    normalizes the files deterministically in well
//                    under a second. Fallback, only if the host read
//                    fails: a background agent reader task (dedupeKey)
//                    that reports through saveBoardSnapshot.
//   saveBoardSnapshot — saves a full normalized snapshot (called by
//                    the fallback reader task; same upsert the fast
//                    path uses).
//   getBoard       — the client reads stored rows through this query
//                    (polled every few seconds while the board is open;
//                    it never touches the relay or the bridge files).
//
// The board is a read-only mirror of the bridges' own records:
// ~/workspace/qq-bridge (inbox/outbox/sendbox/pool.jsonl/attempts.jsonl
// + claimed/ + state markers under ~/hooks/state/qq-bridge) and
// ~/workspace/desktop-bridge (inbox/outbox + markers under
// ~/hooks/state/desktop-bridge).

import {
  defineAction,
  z,
  type ActionsModule,
  type Ctx,
} from "@hatch/space-sdk";
import { asc } from "drizzle-orm";
import * as schema from "./schema";
import { privileged } from "@space/privileged";

const channelEnum = z.enum(["qq", "desktop"]);
const statusEnum = z.enum([
  "queued",
  "replying",
  "waiting_send",
  "delivered",
  "skipped",
  "expired",
  "failed",
]);
const reasonSourceEnum = z.enum(["recorded", "inferred", "unknown"]);

const messageOut = z.object({
  id: z.number(),
  channel: channelEnum,
  requestKey: z.string(),
  conversationLabel: z.string().nullable(),
  senderName: z.string().nullable(),
  senderRole: z.string().nullable(),
  kind: z.enum(["reply", "proactive"]),
  text: z.string(),
  attachments: z.array(z.string()),
  status: statusEnum,
  // The delivery engine's own per-row verdict from the collectors'
  // snapshot (rows[].delivery), when one exists for this row. State
  // "uncertain" （送达待核对） is terminal there even while the
  // bridge status below still reads waiting_send; the page settles
  // such rows instead of showing them as forever-sending.
  deliveryState: z.string().nullable(),
  deliveryLabel: z.string().nullable(),
  statusReason: z.string().nullable(),
  reasonSource: reasonSourceEnum.nullable(),
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
  waitMs: z.number().nullable(),
  composeMs: z.number().nullable(),
  shipMs: z.number().nullable(),
  totalMs: z.number().nullable(),
});

const snapshotMessageIn = z.object({
  channel: channelEnum,
  requestKey: z.string().min(1).max(128),
  conversationId: z.string().max(256).nullable().optional(),
  conversationLabel: z.string().max(128).nullable().optional(),
  senderName: z.string().max(128).nullable().optional(),
  senderRole: z.string().max(32).nullable().optional(),
  kind: z.enum(["reply", "proactive"]).default("reply"),
  text: z.string().max(4000).default(""),
  attachments: z.array(z.string().max(64)).max(8).default([]),
  status: statusEnum,
  statusReason: z.string().max(500).nullable().optional(),
  reasonSource: reasonSourceEnum.nullable().optional(),
  replyText: z.string().max(4000).nullable().optional(),
  replyAttachments: z.array(z.string().max(64)).max(8).default([]),
  receivedAtMs: z.number().int().nullable().optional(),
  fetchedAtMs: z.number().int().nullable().optional(),
  repliedAtMs: z.number().int().nullable().optional(),
  deliveredAtMs: z.number().int().nullable().optional(),
  firstSentAtMs: z.number().int().nullable().optional(),
  reviewPending: z.boolean().default(false),
  expiresAtMs: z.number().int().nullable().optional(),
  receivedDerived: z.boolean().default(false),
});

const healthIn = z.object({
  channel: channelEnum,
  lastFetchStatus: z.string().max(128).nullable().optional(),
  lastFetchAtMs: z.number().int().nullable().optional(),
  detail: z.string().max(500).nullable().optional(),
});

// Pipeline signal from the collectors' board-status.json: gateway
// node + intake edge + per-stage counts per lane, plus the sample
// time. The fast reader supplies it; the fallback agent reader omits
// it and the previously stored signal is kept.
const laneSignal = z.object({ state: z.string(), label: z.string() });
const laneCounts = z.object({
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
});
const laneIn = z.object({
  node: laneSignal.nullable(),
  intake: laneSignal.nullable(),
  counts: laneCounts,
});
const pipelineIn = z.object({
  sampledAtMs: z.number().int().nullable(),
  // Per-row delivery verdicts (collectors' rows[].delivery), keyed
  // by requestKey. Optional: older snapshots without it keep the
  // previously stored map.
  rowDelivery: z
    .record(z.string(), z.object({ state: z.string(), label: z.string() }))
    .optional(),
  lanes: z.object({
    qq: laneIn.nullable(),
    desktop: laneIn.nullable(),
  }),
});

const snapshotIn = z.object({
  messages: z.array(snapshotMessageIn).max(200),
  health: z.array(healthIn).max(4).default([]),
  readerNote: z.string().max(500).nullable().optional(),
  pipeline: pipelineIn.nullable().optional(),
});

type SnapshotIn = z.infer<typeof snapshotIn>;

// Shared upsert for both refresh paths (privileged fast reader and
// the fallback agent reader via saveBoardSnapshot).
async function applySnapshot(ctx: Ctx, args: SnapshotIn): Promise<number> {
  const db = ctx.db<typeof schema>();
  const now = Date.now();
  let saved = 0;
  for (const m of args.messages) {
    const values = {
      channel: m.channel,
      requestKey: m.requestKey,
      conversationId: m.conversationId ?? null,
      conversationLabel: m.conversationLabel ?? null,
      senderName: m.senderName ?? null,
      senderRole: m.senderRole ?? null,
      kind: m.kind,
      text: m.text,
      attachments: JSON.stringify(m.attachments),
      status: m.status,
      statusReason: m.statusReason ?? null,
      reasonSource: m.reasonSource ?? null,
      replyText: m.replyText ?? null,
      replyAttachments: JSON.stringify(m.replyAttachments),
      receivedAtMs: m.receivedAtMs ?? null,
      fetchedAtMs: m.fetchedAtMs ?? null,
      repliedAtMs: m.repliedAtMs ?? null,
      deliveredAtMs: m.deliveredAtMs ?? null,
      firstSentAtMs: m.firstSentAtMs ?? null,
      reviewPending: m.reviewPending,
      expiresAtMs: m.expiresAtMs ?? null,
      receivedDerived: m.receivedDerived,
      updatedAtMs: now,
    };
    await db
      .insert(schema.messages)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.messages.channel, schema.messages.requestKey],
        set: {
          conversationId: values.conversationId,
          conversationLabel: values.conversationLabel,
          senderName: values.senderName,
          senderRole: values.senderRole,
          kind: values.kind,
          text: values.text,
          attachments: values.attachments,
          status: values.status,
          statusReason: values.statusReason,
          reasonSource: values.reasonSource,
          replyText: values.replyText,
          replyAttachments: values.replyAttachments,
          receivedAtMs: values.receivedAtMs,
          fetchedAtMs: values.fetchedAtMs,
          repliedAtMs: values.repliedAtMs,
          deliveredAtMs: values.deliveredAtMs,
          firstSentAtMs: values.firstSentAtMs,
          reviewPending: values.reviewPending,
          expiresAtMs: values.expiresAtMs,
          receivedDerived: values.receivedDerived,
          updatedAtMs: now,
        },
      });
    saved += 1;
  }
  for (const h of args.health) {
    const hv = {
      channel: h.channel,
      lastFetchStatus: h.lastFetchStatus ?? null,
      lastFetchAtMs: h.lastFetchAtMs ?? null,
      detail: h.detail ?? null,
    };
    await db
      .insert(schema.channelHealth)
      .values(hv)
      .onConflictDoUpdate({
        target: schema.channelHealth.channel,
        set: {
          lastFetchStatus: hv.lastFetchStatus,
          lastFetchAtMs: hv.lastFetchAtMs,
          detail: hv.detail,
        },
      });
  }
  // Pipeline signal: only overwrite when this snapshot carries one,
  // so a fallback-reader snapshot never erases the last known signal
  // (its sampledAt going stale is exactly what the page reports).
  const stateSet: {
    refreshedAtMs: number;
    readerNote: string | null;
    sampledAtMs?: number | null;
    lanesJson?: string;
    rowDeliveryJson?: string;
  } = { refreshedAtMs: now, readerNote: args.readerNote ?? null };
  if (args.pipeline != null) {
    stateSet.sampledAtMs = args.pipeline.sampledAtMs;
    stateSet.lanesJson = JSON.stringify(args.pipeline.lanes);
    if (args.pipeline.rowDelivery != null) {
      stateSet.rowDeliveryJson = JSON.stringify(args.pipeline.rowDelivery);
    }
  }
  await db
    .insert(schema.boardState)
    .values({ id: 1, ...stateSet })
    .onConflictDoUpdate({
      target: schema.boardState.id,
      set: stateSet,
    });
  ctx.invalidateQueries();
  return saved;
}

function parseAttachments(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function segment(
  from: number | null,
  to: number | null,
): number | null {
  if (from == null || to == null) return null;
  const d = to - from;
  return d >= 0 ? d : null;
}

const READER_TASK = [
  "You are the snapshot reader for the QQ + desktop message board (web artifact slug: qqyu-zhuo-mian-xiao-xi-kan-ban).",
  "Read the two chat bridges' LOCAL records on this machine and report one normalized snapshot by calling the artifact's saveBoardSnapshot action (use artifact.list_actions / artifact.invoke_action with slug qqyu-zhuo-mian-xiao-xi-kan-ban). Do not invent any message, time, or reason: everything must come from the files below. If a directory is unreadable, report that channel with an empty message list and a health detail saying so.",
  "",
  "SOURCES",
  "QQ bridge: /home/hatch/workspace/qq-bridge/inbox/*.json, outbox/*.json, sendbox/*.json, pool.jsonl, members.json; state markers and log in /home/hatch/hooks/state/qq-bridge/ (files named sent-<key>, sent-send-<key>, fallback-<key>, listed.txt, relay.log).",
  "Desktop bridge: /home/hatch/workspace/desktop-bridge/inbox/*.json, outbox/*.json; markers and log in /home/hatch/hooks/state/desktop-bridge/ (sent-<key>, lost-<key>, relay.log).",
  "File mtimes matter: use `stat -c %Y` (seconds) x1000 for inbox/outbox file times and sent/lost/fallback marker times.",
  "",
  "SEND-ATTEMPT LEDGER (both bridges): the shippers record every send attempt in attempts.jsonl inside each bridge's own directory (/home/hatch/workspace/qq-bridge/attempts.jsonl; desktop bridge likewise if present) — one JSON object per line with key/at/status. firstSentAtMs = the EARLIEST attempt timestamp for the key (either channel, reply and proactive rows alike); null when the ledger has no attempt for the key. This field is what separates 'reply written, not yet sent' from 'request submitted, waiting for the platform receipt' — never guess it from outbox or marker times.",
  "CLAIMS: each bridge's claimed/<requestKey>.claim file marks when an answering worker picked the message up. fetchedAtMs = the claim file's mtime when a claim exists (that is the real wait-for-a-worker segment), else the inbox file mtime. A message with a claim but no outbox yet is 'replying' (several may be replying at once — the bridges answer with up to 3 parallel workers); a message with neither claim nor outbox is 'queued'.",
  "REVIEW STATE (QQ proactive sends ONLY): if a proactive send's ship/ledger record shows the gateway accepted it but QQ platform review is still pending (any review/审核 marker in the send result), set reviewPending=true on that row. Ordinary replies have NO review state — never set reviewPending on kind=reply rows or on desktop rows.",
  "",
  "QQ MESSAGE ROWS (kind=reply), one per inbox file, keyed by requestKey:",
  "- senderName = senderNickname (fall back to members.json nickname by senderId, else '?'), senderRole = senderRole or '' ; conversationLabel = the group label from members.json (currently 宁宁测试); conversationId from the inbox file.",
  "- text = inbox text; attachments = mime types from inbox attachments array.",
  "- receivedAtMs = inbox timestamp; if timestamp is missing/0, use expiresAt-300000 and set receivedDerived=true. fetchedAtMs = claim mtime if claimed/<key>.claim exists, else inbox file mtime. expiresAtMs = expiresAt.",
  "- Parse pool.jsonl: events keyed by `key` with kind recv/sent/skipped/expired (ts in ms). A pool `sent` event (via=reply) is authoritative proof of delivery even if the outbox file was later overwritten by a skip (this really happens).",
  "- Status derivation, in order: (1) pool sent event for the key -> delivered (even if the outbox was later overwritten by a skip); a sent-<key> marker also proves delivered ONLY when the outbox is not a skip (the shipper marks processed skip files too). deliveredAtMs = marker mtime, or pool sent ts if no marker; replyText/replyAttachments from the outbox file if it has text, else from the pool sent event. (2) outbox file has skip:true -> skipped (even if a fallback marker exists). (3) outbox file has text but no sent marker and no fallback marker -> waiting_send; repliedAtMs = outbox mtime. (4) no outbox (or outbox exists but fallback-<key> marker exists and it was never delivered) and now > expiresAt -> expired. (5) no outbox and now <= expiresAt -> replying if a claim file exists for the key, else queued. (6) outbox exists, unexpired, no sent marker -> waiting_send.",
  "- repliedAtMs for delivered rows = outbox file mtime, but if that is AFTER deliveredAtMs (file rewritten later), use the pool sent ts instead and set repliedAtMs = pool sent ts (compose/ship segments must never go negative; the save action drops negative segments anyway).",
  "- skipped reasons: look for evidence in members.json notes and pool context: if the message is a pure face/emoji payload (text starts with <faceType) -> reason '纯表情/贴图，没有可接的话题' source inferred; if members notes say the message expired before the worker woke （已过 5 分钟有效期/未回复） -> '唤醒时已过 5 分钟回复有效期' source recorded; if the request was an NSFW image for the group (e.g. text mentions nsfw) -> '群内不发此类图，平台审核也会拦' source inferred; otherwise statusReason=null, reasonSource='unknown'.",
  "- expired rows: statusReason='超过 5 分钟回复有效期仍未写出回复', reasonSource='recorded' when a fallback marker or pool expired event exists, else 'inferred'.",
  "",
  "QQ PROACTIVE ROWS (kind=proactive), one per sendbox file that HAS a sent-send-<key> marker: channel=qq, requestKey = the sendbox requestKey, senderName=null, status=delivered, deliveredAtMs = marker mtime, fetchedAtMs/receivedAtMs = null, text = sendbox text (may be ''), replyText=null, attachments from imagePath/audioPath presence ('image'/'audio'). Sendbox files without a sent marker: status=waiting_send, deliveredAtMs=null.",
  "",
  "DESKTOP ROWS, one per inbox file in /home/hatch/workspace/desktop-bridge/inbox:",
  "- channel=desktop, kind=reply, conversationLabel='宁宁 · 桌面端', conversationId from file, senderName=null, senderRole=null.",
  "- text = the inbox file's `text` field ONLY. NEVER copy the `messages` array (it contains a character system prompt) into the snapshot.",
  "- receivedAtMs = inbox file mtime, receivedDerived=true (this channel has no message timestamp; expiresAt is about 3 minutes after arrival). fetchedAtMs = claim mtime if /home/hatch/workspace/desktop-bridge/claimed/<key>.claim exists, else the same inbox mtime. expiresAtMs = numeric expiresAt (it may be a string in JSON — convert).",
  "- Status: sent-<key> marker -> delivered (deliveredAtMs = marker mtime, repliedAtMs = outbox mtime, replyText = outbox text). Outbox exists, no marker, unexpired -> waiting_send. Outbox exists, no marker, expired or lost-<key> marker -> expired with statusReason='桌面端没有主动补发通道，过期回复已记录为丢失', reasonSource='recorded' if lost marker exists else 'inferred'. No outbox, unexpired -> replying if a claim file exists for the key, else queued. No outbox, expired -> expired, reason '超过回复有效期仍未写出回复', source inferred.",
  "",
  "HEALTH, one entry per channel: read the tail of that channel's relay.log. lastFetchStatus = the most recent recognizable fetch outcome: 'ok' if recent lines show pool_sync_new/fetch success, else the last fetch_error:* token (e.g. 'http_503', 'RemoteDisconnected'); lastFetchAtMs = relay.log file mtime; detail = a one-line summary of the last few log lines (e.g. '最近多次 fetch_error:http_503'). If the log shows only pool_sync_new=0 lines and no errors recently, status='ok'.",
  "",
  "PIPELINE SIGNAL: the chain diagram's lanes/sampledAt come from the collectors' board-status.json and are maintained by the fast host reader — omit the `pipeline` field from your snapshot entirely (the stored signal is preserved when absent).",
  "Finally call saveBoardSnapshot ONCE with { messages: [...all rows...], health: [qq, desktop], readerNote: one short line about anything anomalous you noticed (or null) }. Cap messages at the 80 most recent per channel by received/fetched time. Report back only a one-line summary.",
].join("\n");

export const Actions = {
  getBoard: defineAction({
    description:
      "Returns the message board: latest QQ + desktop bridge messages with statuses, reasons and segment timings, per-channel health, and the last snapshot time.",
    request: z.object({
      limit: z.number().int().positive().max(200).default(80),
    }),
    response: z.object({
      refreshedAtMs: z.number().nullable(),
      readerNote: z.string().nullable(),
      // Server clock at response time; the page calibrates the
      // pipeline snapshot's age against it (ageMs = serverNow -
      // sampledAtMs) instead of trusting the viewer's clock.
      serverNow: z.number(),
      pipeline: z
        .object({
          sampledAtMs: z.number().nullable(),
          lanes: z.object({
            qq: laneIn.nullable(),
            desktop: laneIn.nullable(),
          }),
        })
        .nullable(),
      health: z.array(
        z.object({
          channel: channelEnum,
          lastFetchStatus: z.string().nullable(),
          lastFetchAtMs: z.number().nullable(),
          detail: z.string().nullable(),
        }),
      ),
      messages: z.array(messageOut),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.messages)
        .orderBy(asc(schema.messages.id));
      const stateRows = await db.select().from(schema.boardState);
      const healthRows = await db.select().from(schema.channelHealth);
      const state = stateRows[0];

      // Per-row delivery verdicts stored with the pipeline signal,
      // keyed by requestKey; merged onto each message below.
      let rowDelivery: Record<string, { state: string; label: string }> = {};
      if (state?.rowDeliveryJson) {
        try {
          const parsed: unknown = JSON.parse(state.rowDeliveryJson);
          const checked = z
            .record(
              z.string(),
              z.object({ state: z.string(), label: z.string() }),
            )
            .safeParse(parsed);
          if (checked.success) rowDelivery = checked.data;
        } catch {
          rowDelivery = {};
        }
      }

      const mapped = rows.map((r) => {
        const anchor = r.receivedAtMs ?? r.fetchedAtMs ?? 0;
        const delivery = rowDelivery[r.requestKey] ?? null;
        return {
          id: r.id,
          channel: r.channel,
          requestKey: r.requestKey,
          conversationLabel: r.conversationLabel,
          senderName: r.senderName,
          senderRole: r.senderRole,
          kind: r.kind,
          text: r.text,
          attachments: parseAttachments(r.attachments),
          status: r.status,
          deliveryState: delivery?.state ?? null,
          deliveryLabel: delivery?.label ?? null,
          statusReason: r.statusReason,
          reasonSource: r.reasonSource,
          replyText: r.replyText,
          replyAttachments: parseAttachments(r.replyAttachments),
          receivedAtMs: r.receivedAtMs,
          fetchedAtMs: r.fetchedAtMs,
          repliedAtMs: r.repliedAtMs,
          deliveredAtMs: r.deliveredAtMs,
          firstSentAtMs: r.firstSentAtMs,
          reviewPending: r.reviewPending,
          expiresAtMs: r.expiresAtMs,
          receivedDerived: r.receivedDerived,
          waitMs: segment(r.receivedAtMs, r.fetchedAtMs),
          composeMs: segment(r.fetchedAtMs, r.repliedAtMs),
          shipMs: segment(r.repliedAtMs, r.deliveredAtMs),
          totalMs: segment(r.receivedAtMs, r.deliveredAtMs),
          _anchor: anchor,
        };
      });
      mapped.sort((a, b) => b._anchor - a._anchor);
      const limited = mapped.slice(0, args.limit).map(({ _anchor, ...m }) => m);

      let lanes: z.infer<typeof pipelineIn>["lanes"] | null = null;
      if (state?.lanesJson) {
        try {
          const parsed: unknown = JSON.parse(state.lanesJson);
          const checked = pipelineIn.shape.lanes.safeParse(parsed);
          if (checked.success) lanes = checked.data;
        } catch {
          lanes = null;
        }
      }

      return {
        refreshedAtMs: state?.refreshedAtMs ?? null,
        readerNote: state?.readerNote ?? null,
        serverNow: Date.now(),
        pipeline:
          state?.sampledAtMs != null || lanes != null
            ? { sampledAtMs: state?.sampledAtMs ?? null, lanes: lanes ?? { qq: null, desktop: null } }
            : null,
        health: healthRows.map((h) => ({
          channel: h.channel,
          lastFetchStatus: h.lastFetchStatus,
          lastFetchAtMs: h.lastFetchAtMs,
          detail: h.detail,
        })),
        messages: limited,
      };
    },
  }),

  refreshBoards: defineAction({
    description:
      "Re-reads both bridges' local records and saves a fresh board snapshot. Fast path: a deterministic host-side reader finishes in well under a second and the snapshot is saved before this returns (fast=true). If the host read fails, falls back to starting a background reader task; new data then appears via getBoard once that task calls saveBoardSnapshot.",
    request: z.object({}),
    response: z.object({
      started: z.boolean(),
      fast: z.boolean(),
      saved: z.number(),
      taskId: z.string().nullable(),
      error: z.string().nullable(),
    }),
    privileged: [privileged.readBridgeSnapshot],
    async handler(ctx) {
      try {
        const snap = await ctx.executePrivileged(
          privileged.readBridgeSnapshot,
          {},
        );
        const saved = await applySnapshot(ctx, snap);
        return { started: true, fast: true, saved, taskId: null, error: null };
      } catch {
        // Host read unavailable (e.g. shared-page runtime): fall back
        // to the agent reader task so a refresh is still possible.
      }
      const result = await ctx.agent.spawnTask(READER_TASK, {
        expectsAction: "saveBoardSnapshot",
        dedupeKey: "bridge-board-refresh",
      });
      if (result.ok) {
        return {
          started: true,
          fast: false,
          saved: 0,
          taskId: result.taskId,
          error: null,
        };
      }
      return {
        started: false,
        fast: false,
        saved: 0,
        taskId: null,
        error: result.error,
      };
    },
  }),

  saveBoardSnapshot: defineAction({
    description:
      "Saves a full normalized snapshot of both bridges' message records (called by the fallback refresh reader task). Upserts messages by (channel, requestKey) and updates channel health and the snapshot time.",
    request: snapshotIn,
    response: z.object({ saved: z.number() }),
    async handler(ctx, args) {
      const saved = await applySnapshot(ctx, args);
      return { saved };
    },
  }),
} satisfies ActionsModule;
