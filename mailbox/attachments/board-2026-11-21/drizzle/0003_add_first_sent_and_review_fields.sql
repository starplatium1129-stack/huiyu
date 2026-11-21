ALTER TABLE messages ADD COLUMN first_sent_at_ms INTEGER;
--> statement-breakpoint
ALTER TABLE messages ADD COLUMN review_pending INTEGER NOT NULL DEFAULT 0;
