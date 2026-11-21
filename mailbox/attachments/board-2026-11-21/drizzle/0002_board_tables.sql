DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  request_key TEXT NOT NULL,
  conversation_id TEXT,
  conversation_label TEXT,
  sender_name TEXT,
  sender_role TEXT,
  kind TEXT NOT NULL DEFAULT 'reply',
  text TEXT NOT NULL DEFAULT '',
  attachments TEXT,
  status TEXT NOT NULL,
  status_reason TEXT,
  reason_source TEXT,
  reply_text TEXT,
  reply_attachments TEXT,
  received_at_ms INTEGER,
  fetched_at_ms INTEGER,
  replied_at_ms INTEGER,
  delivered_at_ms INTEGER,
  expires_at_ms INTEGER,
  received_derived INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX messages_channel_key ON messages (channel, request_key);
--> statement-breakpoint
CREATE TABLE board_state (
  id INTEGER PRIMARY KEY,
  refreshed_at_ms INTEGER,
  reader_note TEXT
);
--> statement-breakpoint
CREATE TABLE channel_health (
  channel TEXT PRIMARY KEY,
  last_fetch_status TEXT,
  last_fetch_at_ms INTEGER,
  detail TEXT
);
