CREATE TABLE `reverse_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`address_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`token` text NOT NULL,
	`blocked` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_reply_at` integer,
	`reply_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reverse_contacts_token_unique` ON `reverse_contacts` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `reverse_contacts_address_email_uq` ON `reverse_contacts` (`address_id`,`email`);--> statement-breakpoint
ALTER TABLE `addresses` ADD `replies_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `domains` ADD `auto_create_user_id` text REFERENCES users(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `domains` ADD `auto_create_category_id` text REFERENCES categories(id) ON DELETE set null;