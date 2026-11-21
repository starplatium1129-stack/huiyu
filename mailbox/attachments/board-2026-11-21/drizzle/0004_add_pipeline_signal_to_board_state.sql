ALTER TABLE `board_state` ADD COLUMN `sampled_at_ms` integer;
--> statement-breakpoint
ALTER TABLE `board_state` ADD COLUMN `lanes_json` text;
