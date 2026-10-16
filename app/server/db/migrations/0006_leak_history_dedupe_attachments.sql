CREATE TABLE `leak_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`address_id` text NOT NULL,
	`sender` text NOT NULL,
	`sender_domain` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `leak_events_user_idx` ON `leak_events` (`user_id`,`sender_domain`);--> statement-breakpoint
CREATE INDEX `leak_events_address_idx` ON `leak_events` (`address_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `body_hash` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `attachments_json` text;