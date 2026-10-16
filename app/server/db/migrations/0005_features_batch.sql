ALTER TABLE `addresses` ADD `blocked_senders_json` text;--> statement-breakpoint
ALTER TABLE `addresses` ADD `trusted_senders_json` text;--> statement-breakpoint
ALTER TABLE `addresses` ADD `leak_sender` text;--> statement-breakpoint
ALTER TABLE `addresses` ADD `leak_at` integer;--> statement-breakpoint
ALTER TABLE `categories` ADD `auto_match` text;--> statement-breakpoint
ALTER TABLE `categories` ADD `retention_days` integer;