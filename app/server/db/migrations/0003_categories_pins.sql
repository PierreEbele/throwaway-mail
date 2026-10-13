CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'zinc' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_user_name_uq` ON `categories` (`user_id`,`name`);--> statement-breakpoint
ALTER TABLE `addresses` ADD `category_id` text REFERENCES categories(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `addresses` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `addresses` ADD `stale_dismissed_at` integer;