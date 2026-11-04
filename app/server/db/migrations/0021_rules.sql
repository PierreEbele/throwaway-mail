CREATE TABLE `delivery_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`address_id` text,
	`message_id` text,
	`destination` text NOT NULL,
	`transport` text NOT NULL,
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text,
	`delivered_to` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`last_retry_at` integer,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `delivery_failures_user_idx` ON `delivery_failures` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `delivery_failures_message_idx` ON `delivery_failures` (`message_id`);--> statement-breakpoint
CREATE TABLE `message_raw` (
	`message_id` text PRIMARY KEY NOT NULL,
	`raw` blob NOT NULL,
	`keep_until` integer,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`address_id` text,
	`category_id` text,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`match` text DEFAULT 'all' NOT NULL,
	`conditions_json` text NOT NULL,
	`actions_json` text NOT NULL,
	`match_count` integer DEFAULT 0 NOT NULL,
	`last_matched_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rules_user_idx` ON `rules` (`user_id`,`position`);--> statement-breakpoint
ALTER TABLE `addresses` ADD `fallback_destination_ids_json` text;--> statement-breakpoint
ALTER TABLE `destinations` ADD `fallback_position` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `raw_headers` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `matched_rules_json` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `quarantined_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `strip_attachments` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `forward_header_allowlist_json` text;