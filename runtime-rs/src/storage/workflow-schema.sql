CREATE TABLE chat_message_records (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE image_batch_plans (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  body TEXT NOT NULL,
  revision INTEGER NOT NULL
);
