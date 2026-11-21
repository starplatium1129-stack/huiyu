// Drizzle schema for the QQ + desktop message board.
//
// `messages` holds one row per bridge message (upserted by
// (channel, request_key) from the bridges' local records by the
// refresh reader task). `board_state` is a single row (id = 1) with
// the last successful snapshot time. `channel_health` holds one row
// per channel with the bridge poller's last fetch outcome, read from
// the bridges' relay logs.

import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channel: text("channel", { enum: ["qq", "desktop"] }).notNull(),
    requestKey: text("request_key").notNull(),
    conversationId: text("conversation_id"),
    conversationLabel: text("conversation_label"),
    senderName: text("sender_name"),
    senderRole: text("sender_role"),
    kind: text("kind", { enum: ["reply", "proactive"] })
      .notNull()
      .default("reply"),
    text: text("text").notNull().default(""),
    attachments: text("attachments"),
    status: text("status", {
      enum: [
        "queued",
        "replying",
        "waiting_send",
        "delivered",
        "skipped",
        "expired",
        "failed",
      ],
    }).notNull(),
    statusReason: text("status_reason"),
    reasonSource: text("reason_source", {
      enum: ["recorded", "inferred", "unknown"],
    }),
    replyText: text("reply_text"),
    replyAttachments: text("reply_attachments"),
    receivedAtMs: integer("received_at_ms"),
    fetchedAtMs: integer("fetched_at_ms"),
    repliedAtMs: integer("replied_at_ms"),
    deliveredAtMs: integer("delivered_at_ms"),
    firstSentAtMs: integer("first_sent_at_ms"),
    reviewPending: integer("review_pending", { mode: "boolean" })
      .notNull()
      .default(false),
    expiresAtMs: integer("expires_at_ms"),
    receivedDerived: integer("received_derived", { mode: "boolean" })
      .notNull()
      .default(false),
    updatedAtMs: integer("updated_at_ms").notNull().default(0),
  },
  (t) => ({
    channelKey: uniqueIndex("messages_channel_key").on(t.channel, t.requestKey),
  }),
);

export const boardState = sqliteTable("board_state", {
  id: integer("id").primaryKey(),
  refreshedAtMs: integer("refreshed_at_ms"),
  readerNote: text("reader_note"),
  // Pipeline signal from the collectors' board-status.json: when the
  // snapshot was sampled (its generatedAt) and the per-lane node /
  // intake / stage-count JSON the chain diagram paints from.
  sampledAtMs: integer("sampled_at_ms"),
  lanesJson: text("lanes_json"),
  // Per-row delivery verdicts from the same board-status.json
  // snapshot (rows[].delivery, keyed by requestKey): a row whose
  // delivery state is "uncertain" （送达待核对） is terminal in the
  // delivery engine even though its bridge status stays
  // waiting_send, and the page renders it as settled.
  rowDeliveryJson: text("row_delivery_json"),
});

export const channelHealth = sqliteTable("channel_health", {
  channel: text("channel", { enum: ["qq", "desktop"] }).primaryKey(),
  lastFetchStatus: text("last_fetch_status"),
  lastFetchAtMs: integer("last_fetch_at_ms"),
  detail: text("detail"),
});
