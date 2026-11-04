CREATE TABLE `smtp_passwords` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`hint` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `smtp_passwords_password_hash_unique` ON `smtp_passwords` (`password_hash`);--> statement-breakpoint
CREATE INDEX `smtp_passwords_user_idx` ON `smtp_passwords` (`user_id`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`user_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_status` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`target_id`) REFERENCES `notify_targets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_due_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_target_idx` ON `webhook_deliveries` (`target_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `notify_targets` ADD `consecutive_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notify_targets` ADD `paused_at` integer;