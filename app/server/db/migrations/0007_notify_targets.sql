CREATE TABLE `notify_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`token` text,
	`chat_id` text,
	`secret` text,
	`events_json` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_ok_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notify_targets_user_idx` ON `notify_targets` (`user_id`);