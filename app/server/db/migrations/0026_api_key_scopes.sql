ALTER TABLE `api_keys` ADD `scope` text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `address_ids` text;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `expires_at` integer;