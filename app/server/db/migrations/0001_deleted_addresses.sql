CREATE TABLE `deleted_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`local_part` text NOT NULL,
	`user_id` text NOT NULL,
	`deleted_at` integer NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deleted_addresses_domain_local_uq` ON `deleted_addresses` (`domain_id`,`local_part`);